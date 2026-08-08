const {
  Client,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const cfg = require('./config');
const { loadJSON, saveJSON } = require('./lib/store');
const api = require('./lib/apiClient');
const { LiveBoard } = require('./lib/live');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const tickets = loadJSON(cfg.TICKETS_FILE, {});

function canTimeout(roles) {
  return roles?.has(cfg.ROLES.TRIAL_MOD) || roles?.has(cfg.ROLES.MOD) || roles?.has(cfg.ROLES.ADMIN) || roles?.has(cfg.ROLES.OWNER);
}
function canKick(roles) {
  return roles?.has(cfg.ROLES.MOD) || roles?.has(cfg.ROLES.ADMIN) || roles?.has(cfg.ROLES.OWNER);
}
function canBan(roles) {
  return roles?.has(cfg.ROLES.ADMIN) || roles?.has(cfg.ROLES.OWNER);
}

async function resolveRobloxUser(username) {
  try {
    const res = await fetch('https://users.roblox.com/usernames/usernames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0];
    if (!row?.id) return null;
    return { id: String(row.id), name: row.name };
  } catch (err) {
    console.error('resolveRobloxUser error:', err.message);
    return null;
  }
}

async function logToDiscord(guild, msg) {
  const ch = guild.channels.cache.get(cfg.LOG_CHANNEL);
  if (ch?.isTextBased()) await ch.send(msg);
}

const COMMANDS = [
  {
    name: 'ban', description: 'Bans a user',
    options: [
      { name: 'user', description: 'The user to ban', type: ApplicationCommandOptionType.User, required: true },
      { name: 'reason', description: 'Reason', type: ApplicationCommandOptionType.String, required: true },
    ],
  },
  {
    name: 'kick', description: 'Kicks a user',
    options: [
      { name: 'user', description: 'The user to kick', type: ApplicationCommandOptionType.User, required: true },
      { name: 'reason', description: 'Reason', type: ApplicationCommandOptionType.String, required: true },
    ],
  },
  {
    name: 'timeout', description: 'Times out a user',
    options: [
      { name: 'user', description: 'The user to timeout', type: ApplicationCommandOptionType.User, required: true },
      { name: 'reason', description: 'Reason', type: ApplicationCommandOptionType.String, required: true },
      { name: 'duration', description: 'Duration', type: ApplicationCommandOptionType.Integer, required: true, choices: [
        { name: '60s', value: 60000 }, { name: '5m', value: 300000 }, { name: '10m', value: 600000 },
        { name: '30m', value: 1800000 }, { name: '1h', value: 3600000 }, { name: '2h', value: 7200000 },
        { name: '4h', value: 14400000 }, { name: '8h', value: 28800000 }, { name: '16h', value: 57600000 },
        { name: '24h', value: 86400000 }, { name: '1w', value: 604800000 },
      ]},
    ],
  },
  {
    name: 'ticket', description: 'Ticket system',
    options: [
      {
        name: 'create', description: 'Open a ticket', type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'type', description: 'Ticket type', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Appeal', value: 'appeal' }, { name: 'Other', value: 'other' }, { name: 'Staff Application', value: 'staff' }] },
          { name: 'reason', description: 'Describe your issue', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'close', description: 'Close the current ticket', type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: 'ingame', description: 'In-game command management',
    options: [
      {
        name: 'ban', description: 'Ban a Roblox player in-game', type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'user', description: 'Roblox username', type: ApplicationCommandOptionType.String, required: true },
          { name: 'reason', description: 'Reason for the ban', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'unban', description: 'Unban a Roblox player in-game', type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'user', description: 'Roblox username', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'announcement', description: 'Send an announcement to the in-game server', type: ApplicationCommandOptionType.Subcommand,
        options: [
          { name: 'text', description: 'The announcement message', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'flashbang', description: 'Flashbang the in-game server', type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: 'banlist', description: 'List all in-game banned players',
  },
];

async function createTicket(guild, user, type, reason) {
  const category = guild.channels.cache.get(cfg.TICKET_CATEGORY);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  const ticketId = String(Math.floor(100000 + Math.random() * 900000));
  const typeSlug = type === 'appeal' ? 'appeal' : type === 'staff' ? 'staff-application' : 'other';
  const typeName = type === 'appeal' ? 'Appeal' : type === 'staff' ? 'Staff Application' : 'Other';

  const channel = await guild.channels.create({
    name: `${typeSlug}-${ticketId}`,
    type: ChannelType.GuildText,
    parent: category.id,
    permissionOverwrites: [
      { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
    ],
  });

  await channel.send(`<@&${cfg.TICKET_PING_ROLE}> Ticket opened by ${user}\n**Type:** ${typeName}\n**Reason:** ${reason}`);

  if (type === 'staff') {
    await channel.send(`**Staff Application - fill out the following format:**\nWhat is your Roblox username?\nWhat is your Discord username?\nHow did you find the server?\nWhy do you want to become OVERCLOCK staff?\nWhat would you bring to OVERCLOCK staff?\nHow long have you been playing futuretops?\nHow active are you on a scale of 1-10? (1= very inactive, 10= incredibly active)`);
  }

  tickets[user.id] = { channelId: channel.id, type, reason, createdAt: new Date().toISOString() };
  saveJSON(cfg.TICKETS_FILE, tickets);

  return { id: ticketId, channel };
}

async function closeTicket(channel, closer, guild) {
  const msgs = [];
  let lastId;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(lastId ? { before: lastId } : {}) });
    if (batch.size === 0) break;
    for (const m of batch.values()) {
      msgs.unshift({ author: `${m.author.tag} (${m.author.id})`, content: m.content || '(attachment)', timestamp: m.createdAt.toISOString(), attachments: [...m.attachments.values()].map(a => a.url) });
    }
    lastId = batch.last()?.id;
  }

  const transcriptFile = `${__dirname}/transcript-${channel.id}.json`;
  fs.writeFileSync(transcriptFile, JSON.stringify(msgs, null, 2));

  const logChannel = guild.channels.cache.get(cfg.LOG_CHANNEL);
  if (logChannel?.isTextBased()) {
    await logChannel.send({ content: `Ticket **${channel.name}** closed by ${closer.tag}`, files: [transcriptFile] });
  }
  fs.unlinkSync(transcriptFile);

  for (const [uid, d] of Object.entries(tickets)) { if (d.channelId === channel.id) { delete tickets[uid]; break; } }
  saveJSON(cfg.TICKETS_FILE, tickets);
  await channel.delete();
}

client.once('ready', async () => {
  client.user.setPresence({ activities: [], status: 'online' });
  console.log(`Logged in as ${client.user.tag}`);

  try {
    await client.application.commands.set([]);
    for (const guild of client.guilds.cache.values()) {
      const cmds = await guild.commands.set(COMMANDS);
      console.log(`Registered ${cmds.size} slash commands in ${guild.name}`);
    }
  } catch (err) {
    console.error('command registration error:', err.message);
  }

  api.getBans()
    .then((bans) => console.log(`[api] connected, ${bans.length} in-game bans loaded`))
    .catch((err) => console.warn('[api] unavailable at startup:', err.message));

  const live = new LiveBoard(client);
  live.start();
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;
  const { commandName } = interaction;
  const roles = interaction.member?.roles?.cache;

  if (commandName === 'ban') {
    if (!canBan(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    try {
      await interaction.guild.members.ban(user, { reason });
      await logToDiscord(interaction.guild, `**"${user.tag}"** (${user.id}) banned by **"${interaction.user.tag}"** - ${reason}`);
      await interaction.reply(`Banned ${user} - ${reason}`);
    } catch (err) { await interaction.reply(`Failed: ${err.message}`); }
    return;
  }

  if (commandName === 'kick') {
    if (!canKick(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.kick(reason);
      await logToDiscord(interaction.guild, `**"${user.tag}"** (${user.id}) kicked by **"${interaction.user.tag}"** - ${reason}`);
      await interaction.reply(`Kicked ${user} - ${reason}`);
    } catch (err) { await interaction.reply(`Failed: ${err.message}`); }
    return;
  }

  if (commandName === 'timeout') {
    if (!canTimeout(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
    const user = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('reason', true);
    const ms = interaction.options.getInteger('duration', true);
    try {
      const member = await interaction.guild.members.fetch(user.id);
      await member.timeout(ms, reason);
      await logToDiscord(interaction.guild, `**"${user.tag}"** (${user.id}) timed out for ${cfg.DUR_NAMES[ms] || ms + 'ms'} by **"${interaction.user.tag}"** - ${reason}`);
      await interaction.reply(`Timed out ${user} for ${cfg.DUR_NAMES[ms] || ms + 'ms'} - ${reason}`);
    } catch (err) { await interaction.reply(`Failed: ${err.message}`); }
    return;
  }

  if (commandName === 'ticket') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      const type = interaction.options.getString('type', true);
      const reason = interaction.options.getString('reason', true);

      if (tickets[interaction.user.id]) {
        await interaction.reply({ content: 'You can only have 1 ticket opened at all times.', ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const result = await createTicket(interaction.guild, interaction.user, type, reason);
      await interaction.editReply(result ? `Ticket **${result.id}** created: <#${result.channel.id}>` : 'Ticket system unavailable.');
      return;
    }

    if (sub === 'close') {
      if (!roles?.has(cfg.SUPPORT_ROLE)) { await interaction.reply({ content: 'Only Support can close tickets.', ephemeral: true }); return; }
      if (interaction.channel?.parentId !== cfg.TICKET_CATEGORY) {
        await interaction.reply({ content: 'Only in ticket channels.', ephemeral: true });
        return;
      }
      await interaction.deferReply();
      await closeTicket(interaction.channel, interaction.user, interaction.guild);
      return;
    }
  }

  if (commandName === 'ingame') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'ban' || sub === 'unban') {
      if (!canBan(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
      const user = interaction.options.getString('user', true).trim();
      const actor = `${interaction.user.tag} (${interaction.user.id})`;

      await interaction.deferReply();

      const resolved = await resolveRobloxUser(user);
      const name = resolved?.name ?? user;
      const id = resolved?.id ?? null;

      if (sub === 'ban') {
        const reason = interaction.options.getString('reason', true).trim();
        try {
          await api.upsertBan({ name, roblox_id: id, reason, banned_by: actor, banned_by_id: interaction.user.id });
        } catch (err) {
          console.error('api ban error:', err.message);
          await interaction.editReply('API error, try again.');
          return;
        }
        await logToDiscord(interaction.guild, `**"${name}"** (${id ?? 'unknown id'}) banned by **"${interaction.user.tag}"** for Reason: **"${reason}"**`);
        await interaction.editReply(`Banned **${name}** in-game${id ? ` (id: ${id})` : ''} - ${reason}`);
        return;
      }

      if (sub === 'unban') {
        let existing = null;
        try {
          const bans = await api.getBans();
          existing = bans.find((b) => b.name.toLowerCase() === name.toLowerCase()) ?? null;
        } catch (err) {
          console.error('api getBans error:', err.message);
          await interaction.editReply('API error, try again.');
          return;
        }
        const target = existing?.name ?? name;
        const targetId = existing?.roblox_id ?? id;
        try {
          await api.deleteBan(target);
        } catch (err) {
          console.error('api unban error:', err.message);
          await interaction.editReply('API error, try again.');
          return;
        }
        await logToDiscord(interaction.guild, `**"${target}"** (${targetId ?? 'unknown id'}) unbanned by **"${interaction.user.tag}"**`);
        await interaction.editReply(`Unbanned **${target}** in-game${targetId ? ` (id: ${targetId})` : ''}`);
        return;
      }
    }

    if (sub === 'announcement') {
      if (!canTimeout(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
      const text = interaction.options.getString('text', true).trim();
      await interaction.deferReply();
      try {
        await api.postAnnouncement(text);
      } catch (err) {
        console.error('api announcement error:', err.message);
        await interaction.editReply('API error, try again.');
        return;
      }
      await logToDiscord(interaction.guild, `Announcement by **"${interaction.user.tag}"**: **"${text}"**`);
      await interaction.editReply(`Announcement sent in-game: ${text}`);
      return;
    }

    if (sub === 'flashbang') {
      if (!canKick(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
      await interaction.deferReply();
      try {
        await api.postCommand(':freaky 255 255 255|1000|:freaky 0 0 0');
      } catch (err) {
        console.error('api flashbang error:', err.message);
        await interaction.editReply('API error, try again.');
        return;
      }
      await logToDiscord(interaction.guild, `Flashbang triggered by **"${interaction.user.tag}"**`);
      await interaction.editReply('Flashbang sent in-game.');
      return;
    }
  }

  if (commandName === 'banlist') {
    let data;
    try {
      data = await api.getBans();
    } catch (err) {
      console.error('api select error:', err.message);
      await interaction.reply({ content: 'API error, try again.', ephemeral: true });
      return;
    }

    if (!data || data.length === 0) {
      await interaction.reply({ content: 'No in-game bans yet.' });
      return;
    }

    const lines = data
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(0, 30)
      .map((b, i) =>
        `${i + 1}. **${b.name}**${b.roblox_id ? ` (id: ${b.roblox_id})` : ''} — ${b.reason} — by ${b.banned_by_id ? `<@${b.banned_by_id}>` : 'unknown'} — <t:${Math.floor(new Date(b.created_at).getTime() / 1000)}>`
      );
    const embed = new EmbedBuilder()
      .setColor(0x2c2323)
      .setTitle(`In-game bans (${data.length}${data.length > 30 ? ', showing first 30' : ''})`)
      .setDescription(lines.join('\n'));

    await interaction.reply({ embeds: [embed] });
    return;
  }
});

if (!cfg.DISCORD_TOKEN) {
  console.error('FATAL: DISCORD_TOKEN not set in .env');
  process.exit(1);
}
client.login(cfg.DISCORD_TOKEN);
