const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { formatTime, progressBar, truncate, isUrl } = require('./utils');

const LOOP_LABEL = { off: 'إيقاف', track: 'الأغنية 🔂', queue: 'القائمة 🔁' };
const COLORS = { playing: 0x2ecc71, paused: 0xf39c12, ended: 0x95a5a6, ok: 0x2ecc71, err: 0xe74c3c, info: 0x5865f2 };

function simpleEmbed(text, kind = 'info') {
  return new EmbedBuilder().setColor(COLORS[kind] ?? COLORS.info).setDescription(text);
}

function progressLine(info, position) {
  if (info.isStream) return '🔴 **بث مباشر**';
  return `\`${formatTime(position)}\` ${progressBar(position, info.length)} \`${formatTime(info.length)}\``;
}

function buildControls(state, paused) {
  const btn = (id, emoji, style = ButtonStyle.Secondary) =>
    new ButtonBuilder().setCustomId(`mp_${id}`).setEmoji(emoji).setStyle(style);

  const loopStyle = state.loop === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success;
  const loopEmoji = state.loop === 'track' ? '🔂' : '🔁';

  return [
    new ActionRowBuilder().addComponents(
      btn('prev', '⏮️'),
      btn('pause', paused ? '▶️' : '⏸️', ButtonStyle.Primary),
      btn('skip', '⏭️'),
      btn('stop', '⏹️', ButtonStyle.Danger),
      btn('loop', loopEmoji, loopStyle),
    ),
    new ActionRowBuilder().addComponents(
      btn('voldown', '🔉'),
      btn('volup', '🔊'),
      btn('shuffle', '🔀'),
      btn('queue', '📜'),
      btn('restart', '🔄'),
    ),
  ];
}

function buildPanel(state, player, opts = {}) {
  const track = state.current;
  const info = track.info;
  const paused = !!player?.paused;
  const position = opts.position ?? player?.position ?? 0;
  const next = state.queue[0];

  const embed = new EmbedBuilder()
    .setColor(paused ? COLORS.paused : COLORS.playing)
    .setAuthor({ name: paused ? '⏸️ متوقف مؤقتاً' : '🎶 يشغّل الآن' })
    .setTitle(truncate(info.title || 'بدون عنوان', 250))
    .setDescription(`**${truncate(info.author || '—', 100)}**\n\n${progressLine(info, position)}`)
    .addFields(
      { name: '🔊 الصوت', value: `${state.volume}%`, inline: true },
      { name: '🔁 التكرار', value: LOOP_LABEL[state.loop], inline: true },
      { name: '👤 الطالب', value: track.requester ? `<@${track.requester.id}>` : '—', inline: true },
      { name: '📜 بالانتظار', value: String(state.queue.length), inline: true },
      { name: '⏭️ التالي', value: next ? truncate(next.info.title, 60) : 'لا يوجد', inline: true },
      { name: '🌙 24/7', value: state.is247 ? 'مفعّل' : 'معطّل', inline: true },
    )
    .setFooter({ text: 'تحكم بالأزرار من نفس الروم الصوتي' });

  if (isUrl(info.uri)) embed.setURL(info.uri);
  if (info.artworkUrl) embed.setThumbnail(info.artworkUrl);

  return { embeds: [embed], components: buildControls(state, paused) };
}

function buildEnded(text) {
  return {
    embeds: [new EmbedBuilder().setColor(COLORS.ended).setAuthor({ name: '⏹️ انتهى التشغيل' }).setDescription(text)],
    components: [],
  };
}

function buildQueueEmbed(state) {
  const lines = [];
  if (state.current) lines.push(`**الآن:** ${truncate(state.current.info.title, 70)}`);
  state.queue.slice(0, 10).forEach((t, i) => {
    const dur = t.info.isStream ? 'بث' : formatTime(t.info.length);
    lines.push(`\`${i + 1}.\` ${truncate(t.info.title, 60)} — \`${dur}\``);
  });
  if (state.queue.length > 10) lines.push(`… و **${state.queue.length - 10}** أخرى`);
  if (!lines.length) lines.push('القائمة فارغة');
  return new EmbedBuilder().setColor(COLORS.info).setTitle('📜 قائمة التشغيل').setDescription(lines.join('\n'));
}

module.exports = { simpleEmbed, buildPanel, buildEnded, buildQueueEmbed };
