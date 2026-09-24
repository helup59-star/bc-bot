const { Shoukaku, Connectors } = require('shoukaku');
const { PermissionsBitField, MessageFlags } = require('discord.js');
const config = require('./settings');
const store = require('./store');
const { parseCommand, isUrl, shuffle, truncate } = require('./utils');
const { simpleEmbed, buildPanel, buildEnded, buildQueueEmbed } = require('./panel');

const VOICE_PERMS = [
  PermissionsBitField.Flags.ViewChannel,
  PermissionsBitField.Flags.Connect,
  PermissionsBitField.Flags.Speak,
];
const NEXT_LOOP = { off: 'track', track: 'queue', queue: 'off' };

class MusicManager {
  constructor(client) {
    this.client = client;
    this.states = new Map(); // guildId -> state
    this.locks = new Map(); // guildId -> promise chain (يمنع تداخل أوامر الدخول/التشغيل)
    this.intentional = new Set(); // خروج مقصود من الروم (عشان ما نعيد الدخول بالغلط)
    this.stored = store.load(); // إعدادات 247 المحفوظة

    const { host, port, password, secure } = config.lavalink;
    this.shoukaku = new Shoukaku(
      new Connectors.DiscordJS(client),
      [{ name: 'main', url: `${host}:${port}`, auth: password, secure }],
      { moveOnDisconnect: false, resume: false, reconnectTries: 20, restTimeout: 20_000 },
    );

    this.shoukaku.on('error', (name, err) => console.error(`[Lavalink:${name}] خطأ:`, err?.message || err));
    this.shoukaku.on('ready', (name, reconnected) => {
      console.log(`✅ [Lavalink:${name}] متصل${reconnected ? ' (إعادة اتصال)' : ''}`);
      this.restore247().catch((e) => console.error('[247] restore:', e));
    });
    this.shoukaku.on('close', (name, code, reason) => {
      console.warn(`[Lavalink:${name}] انقطع الاتصال (${code} ${reason || ''})`);
      this.dropAll();
    });
  }

  // ───────────────────────── حالة السيرفر ─────────────────────────
  getState(guildId) {
    let s = this.states.get(guildId);
    if (!s) {
      s = {
        guildId,
        queue: [],
        history: [],
        current: null,
        loop: 'off',
        volume: config.defaultVolume,
        textChannelId: this.stored[guildId]?.textChannelId ?? null,
        panel: null,
        idleTimer: null,
        emptyTimer: null,
        progressTimer: null,
        is247: Boolean(this.stored[guildId]),
      };
      this.states.set(guildId, s);
    }
    return s;
  }

  locked(guildId, fn) {
    const prev = this.locks.get(guildId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.locks.set(guildId, run.catch(() => {}));
    return run;
  }

  clearTimers(s) {
    clearTimeout(s.idleTimer);
    clearTimeout(s.emptyTimer);
    clearInterval(s.progressTimer);
    s.idleTimer = s.emptyTimer = s.progressTimer = null;
  }

  textChannel(s) {
    const ch = s.textChannelId && this.client.channels.cache.get(s.textChannelId);
    return ch?.isTextBased() ? ch : null;
  }

  notify(s, text, kind = 'info') {
    return this.textChannel(s)?.send({ embeds: [simpleEmbed(text, kind)] }).catch(() => {});
  }

  // ───────────────────────── الاتصال بالروم ─────────────────────────
  async ensurePlayer(guild, voiceChannel) {
    const existing = this.shoukaku.players.get(guild.id);
    if (existing) return existing;
    const player = await this.shoukaku.joinVoiceChannel({
      guildId: guild.id,
      channelId: voiceChannel.id,
      shardId: guild.shardId,
      deaf: true,
    });
    this.attachPlayerEvents(player, guild.id);
    const s = this.getState(guild.id);
    if (s.volume !== 100) await player.setGlobalVolume(s.volume).catch(() => {});
    return player;
  }

  attachPlayerEvents(player, guildId) {
    const matches = (data) => {
      const s = this.states.get(guildId);
      return s?.current && (!data?.track?.encoded || data.track.encoded === s.current.encoded);
    };

    player.on('end', async (data) => {
      if (String(data?.reason).toLowerCase() !== 'finished') return; // الفشل تتعامل معه exception
      if (!matches(data)) return;
      await this.next(guildId, 'finished').catch((e) => console.error('[end]', e));
    });
    player.on('exception', async (data) => {
      console.error('[track exception]', data?.exception?.message || data);
      if (matches(data)) await this.handleFailure(guildId).catch((e) => console.error(e));
    });
    player.on('stuck', async (data) => {
      console.warn('[track stuck]');
      if (matches(data)) await this.handleFailure(guildId).catch((e) => console.error(e));
    });
    player.on('closed', (data) => console.warn('[voice ws closed]', data?.code, data?.reason));
  }

  // لو فشل تشغيل مقطع يوتيوب نجرب نفس الاسم من ساوندكلاود مرة وحدة
  async handleFailure(guildId) {
    const s = this.states.get(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (!s?.current || !player) return;
    const cur = s.current;

    if (!cur.fallbackTried && /youtube/i.test(cur.info.sourceName || '')) {
      try {
        const res = await this.shoukaku.getIdealNode()?.rest.resolve(`scsearch:${cur.info.title} ${cur.info.author}`);
        const alt = res?.loadType === 'search' ? res.data[0] : null;
        if (alt) {
          this.notify(s, `⚠️ تعذر التشغيل من يوتيوب، جرّبت **SoundCloud** للأغنية: ${truncate(cur.info.title, 60)}`);
          return this.play(s, player, { ...alt, requester: cur.requester, fallbackTried: true });
        }
      } catch (e) {
        console.error('[fallback]', e?.message || e);
      }
    }
    this.notify(s, `❌ تعذر تشغيل **${truncate(cur.info.title, 60)}** وتم تخطيها`, 'err');
    await this.next(guildId, 'exception');
  }

  // ───────────────────────── البحث ─────────────────────────
  async search(query) {
    const node = this.shoukaku.getIdealNode();
    if (!node) throw new Error('NO_NODE');
    const ids = isUrl(query) ? [query.trim()] : [`${config.searchPrefix}:${query}`, `scsearch:${query}`];

    for (const id of ids) {
      let res;
      try {
        res = await node.rest.resolve(id);
      } catch (e) {
        console.error('[resolve]', id.slice(0, 60), e?.message || e);
        continue;
      }
      if (!res) continue;
      if (res.loadType === 'track') return { tracks: [res.data], playlist: null };
      if (res.loadType === 'search' && res.data.length) return { tracks: [res.data[0]], playlist: null };
      if (res.loadType === 'playlist' && res.data.tracks.length) {
        return { tracks: res.data.tracks, playlist: res.data.info?.name || 'قائمة' };
      }
      if (res.loadType === 'error') console.error('[resolve error]', res.data?.message);
    }
    return null;
  }

  // ───────────────────────── التشغيل والطابور ─────────────────────────
  async next(guildId, reason) {
    const s = this.states.get(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (!s || !player) return;
    clearTimeout(s.idleTimer);

    const prev = s.current;
    let nextTrack = null;
    if (prev && reason === 'finished' && s.loop === 'track') {
      nextTrack = prev;
    } else {
      if (prev) {
        s.history.push(prev);
        if (s.history.length > 20) s.history.shift();
        if (s.loop === 'queue' && reason !== 'exception') s.queue.push(prev);
      }
      nextTrack = s.queue.shift() ?? null;
    }

    if (!nextTrack) {
      s.current = null;
      clearInterval(s.progressTimer);
      if (reason !== 'finished') await player.stopTrack().catch(() => {});
      await this.finishPanel(s, '✅ انتهت قائمة التشغيل. اكتب أمر التشغيل لإضافة المزيد.');
      if (!s.is247) s.idleTimer = setTimeout(() => this.leave(guildId), config.idleLeaveMs);
      return;
    }
    await this.play(s, player, nextTrack);
  }

  async play(s, player, track) {
    clearTimeout(s.idleTimer);
    s.current = track;
    try {
      await player.playTrack({ track: { encoded: track.encoded } });
      if (player.paused) await player.setPaused(false);
    } catch (e) {
      console.error('[play] فشل:', e?.message || e);
      this.notify(s, `❌ تعذر تشغيل **${truncate(track.info.title, 60)}**`, 'err');
      return this.next(s.guildId, 'exception');
    }
    await this.sendPanel(s, player);
    clearInterval(s.progressTimer);
    s.progressTimer = setInterval(() => this.refreshPanel(s).catch(() => {}), 15_000);
  }

  async previous(s, player) {
    const prev = s.history.pop();
    if (!prev) return false;
    if (s.current) s.queue.unshift(s.current);
    await this.play(s, player, prev);
    return true;
  }

  async stop(guildId) {
    const s = this.states.get(guildId);
    const player = this.shoukaku.players.get(guildId);
    if (!s) return;
    s.queue = [];
    s.history = [];
    s.current = null;
    s.loop = 'off';
    clearInterval(s.progressTimer);
    if (player) await player.stopTrack().catch(() => {});
    await this.finishPanel(s, '⏹️ تم الإيقاف ومسح القائمة.');
    if (s.is247) return;
    await this.leave(guildId);
  }

  async leave(guildId) {
    const s = this.states.get(guildId);
    const guild = this.client.guilds.cache.get(guildId);
    if (guild?.members.me?.voice?.channelId) {
      this.intentional.add(guildId);
      setTimeout(() => this.intentional.delete(guildId), 10_000);
    }
    if (s) {
      this.clearTimers(s);
      await this.finishPanel(s, '👋 تم الخروج من الروم الصوتي.');
      this.states.delete(guildId);
    }
    try { await this.shoukaku.leaveVoiceChannel(guildId); } catch { /* غير متصل أصلاً */ }
  }

  dropAll() {
    for (const guildId of [...this.states.keys()]) this.leave(guildId).catch(() => {});
  }

  // ───────────────────────── اللوحة ─────────────────────────
  async sendPanel(s, player) {
    const ch = this.textChannel(s);
    if (!ch || !s.current) return;
    const old = s.panel;
    s.panel = null;
    try {
      s.panel = await ch.send(buildPanel(s, player, { position: 0 }));
    } catch (e) {
      console.error('[panel] تعذر إرسال اللوحة (تأكد من صلاحيات Send Messages/Embed Links):', e.message);
    }
    old?.delete().catch(() => {});
  }

  async refreshPanel(s, { force = false } = {}) {
    const player = this.shoukaku.players.get(s.guildId);
    if (!s.panel || !s.current || !player) return;
    if (!force && player.paused) return;
    await s.panel.edit(buildPanel(s, player)).catch((e) => {
      if (e?.code === 10008) { // الرسالة انحذفت
        s.panel = null;
        clearInterval(s.progressTimer);
      }
    });
  }

  async finishPanel(s, text) {
    const panel = s.panel;
    s.panel = null;
    await panel?.edit(buildEnded(text)).catch(() => {});
  }

  // ───────────────────────── 24/7 ─────────────────────────
  async restore247() {
    for (const [guildId, cfg] of Object.entries(this.stored)) {
      try {
        const guild = this.client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(cfg.voiceChannelId);
        if (!channel || this.shoukaku.players.has(guildId)) continue;
        const s = this.getState(guildId);
        s.is247 = true;
        s.textChannelId = cfg.textChannelId ?? s.textChannelId;
        await this.ensurePlayer(guild, channel);
        console.log(`🌙 [24/7] رجعت للروم في ${guild.name}`);
      } catch (e) {
        console.error(`[24/7] تعذر الرجوع للسيرفر ${guildId}:`, e?.message || e);
      }
    }
  }

  async cmd247(message, member) {
    const { guild, channel } = message;
    const s = this.getState(guild.id);

    if (s.is247) {
      s.is247 = false;
      delete this.stored[guild.id];
      store.save(this.stored);
      if (!s.current) s.idleTimer = setTimeout(() => this.leave(guild.id), config.idleLeaveMs);
      return this.say(message, '🌙 تم **إيقاف** وضع 24/7. راح أطلع من الروم إذا ما فيه تشغيل.', 'ok');
    }

    const vc = member.voice.channel;
    if (!vc) return this.say(message, 'ادخل الروم الصوتي اللي تبيني أثبت فيه ثم اكتب الأمر 🎧', 'err');
    if (!this.canJoin(vc, guild)) return this.say(message, 'ما عندي صلاحية (عرض/دخول/تحدث) في هذا الروم', 'err');

    try {
      await this.locked(guild.id, async () => {
        const botVc = guild.members.me?.voice?.channel;
        let st = this.getState(guild.id);
        if (botVc && botVc.id !== vc.id) {
          if (st.current) throw new Error('BUSY');
          await this.leave(guild.id);
          st = this.getState(guild.id);
        }
        st.textChannelId = channel.id;
        await this.ensurePlayer(guild, vc);
        st.is247 = true;
        clearTimeout(st.idleTimer);
        clearTimeout(st.emptyTimer);
        this.stored[guild.id] = { voiceChannelId: vc.id, textChannelId: channel.id };
        store.save(this.stored);
      });
    } catch (e) {
      if (e.message === 'BUSY') return this.say(message, 'أنا أشغّل في روم ثاني حالياً، أوقفني أولاً بأمر الإيقاف', 'err');
      console.error('[247]', e);
      return this.say(message, 'تعذر الدخول للروم الصوتي، جرّب مرة ثانية', 'err');
    }
    return this.say(message, `🌙 تم تفعيل **24/7** — أنا ثابت في ${vc} حتى لو ما فيه أحد، ويرجع تلقائياً بعد إعادة التشغيل.`, 'ok');
  }

  // ───────────────────────── الأوامر النصية ─────────────────────────
  say(message, text, kind = 'info') {
    return message.reply({ embeds: [simpleEmbed(text, kind)], allowedMentions: { repliedUser: false } }).catch(() => {});
  }

  canJoin(channel, guild) {
    const me = guild.members.me;
    return me ? channel.permissionsFor(me)?.has(VOICE_PERMS) : false;
  }

  async onMessage(message) {
    if (message.author.bot || !message.guild || message.system) return;
    const parsed = parseCommand(message.content, config.prefix, config.noPrefix);
    if (!parsed) return;
    const { cmd, args, usedPrefix } = parsed;
    const isOwner = config.owners.has(message.author.id);

    // بدون بريفكس: نتجاهل الكلام العادي (لازم يكون في روم صوتي، وسكب/وقف لازم تكون الرسالة الأمر فقط)
    if (!usedPrefix) {
      if (!message.member?.voice?.channel && !(cmd === '247' && isOwner)) return;
      if (cmd === 'play' && !args.length) return;
      if (cmd !== 'play' && args.length) return;
      if (cmd === '247' && !isOwner) return;
    }
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;

    if (cmd === 'play') return this.cmdPlay(message, member, args);
    if (cmd === '247') {
      if (!isOwner) return this.say(message, 'هذا الأمر لأونر البوت فقط 🔒', 'err');
      return this.cmd247(message, member);
    }

    // skip / stop (بدون بريفكس نرد بصمت لو الشروط ما تحققت عشان ما نزعج الشات)
    const s = this.states.get(message.guild.id);
    const botVc = message.guild.members.me?.voice?.channelId;
    if (!s || !botVc) return usedPrefix ? this.say(message, 'ما فيه تشغيل حالياً', 'err') : undefined;
    if (!isOwner && member.voice.channelId !== botVc) {
      return usedPrefix ? this.say(message, 'لازم تكون في نفس الروم الصوتي مع البوت 🎧', 'err') : undefined;
    }

    if (cmd === 'skip') {
      if (!s.current) return this.say(message, 'ما فيه شي يشتغل عشان أتخطاه', 'err');
      const title = truncate(s.current.info.title, 60);
      await this.next(message.guild.id, 'skip');
      return this.say(message, `⏭️ تم تخطي **${title}**`, 'ok');
    }
    if (cmd === 'stop') {
      await this.stop(message.guild.id);
      return this.say(message, '⏹️ تم الإيقاف ومسح القائمة', 'ok');
    }
  }

  async cmdPlay(message, member, args) {
    const { guild, channel } = message;
    const vc = member.voice.channel;
    if (!vc) return this.say(message, 'ادخل روم صوتي أولاً 🎧', 'err');

    const query = args.join(' ').trim();
    if (!query) return this.say(message, `اكتب اسم الأغنية أو الرابط.\nمثال: \`${config.prefix}ش اسم الأغنية\``, 'err');

    const botVc = guild.members.me?.voice?.channel;
    if (botVc && botVc.id !== vc.id) {
      if (this.states.get(guild.id)?.current) return this.say(message, `أنا أشغّل حالياً في ${botVc}`, 'err');
      if (this.stored[guild.id]) return this.say(message, `أنا مثبّت 24/7 في ${botVc}`, 'err');
    }
    if (!this.canJoin(vc, guild)) return this.say(message, 'ما عندي صلاحية (عرض/دخول/تحدث) في هذا الروم', 'err');

    channel.sendTyping().catch(() => {});
    let found;
    try {
      found = await this.search(query);
    } catch (e) {
      const msg = e.message === 'NO_NODE' ? 'خادم الصوت (Lavalink) غير متصل حالياً، جرّب بعد شوي' : 'صار خطأ أثناء البحث';
      return this.say(message, msg, 'err');
    }
    if (!found) return this.say(message, 'ما لقيت نتائج 😕', 'err');

    const requester = { id: member.id, name: member.displayName };
    const items = found.tracks.slice(0, 100).map((t) => ({ ...t, requester }));

    try {
      await this.locked(guild.id, async () => {
        let s = this.getState(guild.id);
        if (botVc && botVc.id !== vc.id) {
          await this.leave(guild.id);
          s = this.getState(guild.id);
        }
        s.textChannelId = channel.id;
        await this.ensurePlayer(guild, vc);
        const wasIdle = !s.current;
        s.queue.push(...items);
        if (wasIdle) {
          if (found.playlist) this.say(message, `📃 تمت إضافة **${items.length}** مقطع من **${truncate(found.playlist, 60)}**`, 'ok');
          await this.next(guild.id, 'start');
        } else if (found.playlist) {
          this.say(message, `📃 تمت إضافة **${items.length}** مقطع من **${truncate(found.playlist, 60)}**`, 'ok');
        } else {
          this.say(message, `✅ تمت الإضافة: **${truncate(items[0].info.title, 70)}** — الترتيب #${s.queue.length}`, 'ok');
        }
      });
    } catch (e) {
      console.error('[play cmd]', e);
      await this.leave(guild.id);
      return this.say(message, 'تعذر الدخول للروم الصوتي أو بدء التشغيل، جرّب مرة ثانية', 'err');
    }
  }

  // ───────────────────────── أزرار اللوحة ─────────────────────────
  async onButton(interaction) {
    if (!interaction.guildId || !interaction.customId.startsWith('mp_')) return;
    const action = interaction.customId.slice(3);
    const s = this.states.get(interaction.guildId);
    const player = this.shoukaku.players.get(interaction.guildId);
    const eph = (text, kind = 'err') =>
      interaction.reply({ embeds: [simpleEmbed(text, kind)], flags: MessageFlags.Ephemeral }).catch(() => {});

    if (!s || !player) return eph('ما فيه تشغيل حالياً.');
    const botVc = interaction.guild.members.me?.voice?.channelId;
    const isOwner = config.owners.has(interaction.user.id);
    if (!isOwner && interaction.member.voice?.channelId !== botVc) {
      return eph('لازم تكون في نفس الروم الصوتي مع البوت عشان تتحكم 🎧');
    }

    if (action === 'queue') {
      return interaction.reply({ embeds: [buildQueueEmbed(s)], flags: MessageFlags.Ephemeral }).catch(() => {});
    }

    await interaction.deferUpdate().catch(() => {});
    switch (action) {
      case 'pause':
        if (s.current) await player.setPaused(!player.paused);
        await this.refreshPanel(s, { force: true });
        break;
      case 'skip':
        if (s.current) await this.next(s.guildId, 'skip');
        break;
      case 'prev':
        if (!(await this.previous(s, player))) {
          interaction.followUp({ embeds: [simpleEmbed('ما فيه أغنية سابقة.', 'err')], flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        break;
      case 'stop':
        await this.stop(s.guildId);
        break;
      case 'loop':
        s.loop = NEXT_LOOP[s.loop];
        await this.refreshPanel(s, { force: true });
        break;
      case 'shuffle':
        shuffle(s.queue);
        await this.refreshPanel(s, { force: true });
        break;
      case 'restart':
        if (s.current) await player.seekTo(0);
        await this.refreshPanel(s, { force: true });
        break;
      case 'volup':
      case 'voldown': {
        const step = action === 'volup' ? 10 : -10;
        s.volume = Math.min(150, Math.max(0, s.volume + step));
        await player.setGlobalVolume(s.volume);
        await this.refreshPanel(s, { force: true });
        break;
      }
    }
  }

  // ───────────────────────── أحداث الروم الصوتي ─────────────────────────
  async onVoiceStateUpdate(oldState, newState) {
    const guild = newState.guild;
    const guildId = guild.id;

    // الحدث يخص البوت نفسه
    if (newState.id === this.client.user.id) {
      if (oldState.channelId && !newState.channelId) {
        if (this.intentional.delete(guildId)) return;
        const cfg = this.stored[guildId];
        await this.leave(guildId);
        if (cfg) setTimeout(() => this.restore247().catch(() => {}), 3000); // انسحب البوت من الروم → يرجع لو 24/7
      }
      return;
    }

    // حدث يخص شخص ثاني: نراقب لو الروم فضي من البشر
    const s = this.states.get(guildId);
    const botChannelId = guild.members.me?.voice?.channelId;
    if (!s || !botChannelId) return;
    if (oldState.channelId !== botChannelId && newState.channelId !== botChannelId) return;

    const humans = guild.channels.cache.get(botChannelId)?.members.filter((m) => !m.user.bot).size ?? 0;
    clearTimeout(s.emptyTimer);
    s.emptyTimer = null;
    if (humans === 0 && !s.is247) {
      s.emptyTimer = setTimeout(() => this.leave(guildId), config.emptyLeaveMs);
    }
  }
}

module.exports = { MusicManager };
