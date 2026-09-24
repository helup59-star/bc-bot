const { Client, GatewayIntentBits, Events, ActivityType } = require('discord.js');
const config = require('./settings');
const { startLavalink, stopLavalink } = require('./lavalinkProcess');
const { MusicManager } = require('./music');

if (!config.token) {
  console.error('❌ ما لقيت توكن البوت. افتح config.json وحط التوكن في DISCORD_TOKEN');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // لازم يكون مفعّل من Developer Portal
  ],
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopLavalink();
    process.exit(0);
  });
}
process.on('exit', stopLavalink);

(async () => {
  if (config.lavalink.autostart) {
    try {
      await startLavalink();
    } catch (e) {
      console.error('❌ Lavalink:', e.message);
      console.error('البوت راح يشتغل بس الموسيقى ما تعمل لين يتوفر Lavalink.');
    }
  }

  const music = new MusicManager(client);

  client.once(Events.ClientReady, (c) => {
    console.log(`🤖 البوت شغّال: ${c.user.tag}`);
    c.user.setActivity(`${config.prefix}ش | شغل`, { type: ActivityType.Listening });
  });
  client.on(Events.MessageCreate, (m) => music.onMessage(m).catch((e) => console.error('[message]', e)));
  client.on(Events.InteractionCreate, (i) => {
    if (i.isButton()) music.onButton(i).catch((e) => console.error('[button]', e));
  });
  client.on(Events.VoiceStateUpdate, (o, n) => music.onVoiceStateUpdate(o, n).catch((e) => console.error('[voice]', e)));

  await client.login(config.token);
})();
