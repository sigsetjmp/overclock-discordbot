require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const {
  Client,
  GatewayIntentBits,
  ApplicationCommandOptionType,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');

const ROLES = {
  TRIAL_MOD: '1535026371523248348',
  MOD: '1535025679756951673',
  ADMIN: '1535025627055259740',
  OWNER: '1535025513410728147',
};

const TICKET_PING_ROLE = '1535039121519542283';
const TICKET_CATEGORY = '1535029532854194206';
const LOG_CHANNEL = '1535028352157745162';
const TICKETS_FILE = path.join(__dirname, 'tickets.json');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const DUR_NAMES = {
  60000: '60s', 300000: '5m', 600000: '10m', 1800000: '30m',
  3600000: '1h', 7200000: '2h', 14400000: '4h', 28800000: '8h',
  57600000: '16h', 86400000: '24h', 604800000: '1w',
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

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
          { name: 'type', description: 'Ticket type', type: ApplicationCommandOptionType.String, required: true, choices: [{ name: 'Appeal', value: 'appeal' }, { name: 'Other', value: 'other' }] },
          { name: 'reason', description: 'Describe your issue', type: ApplicationCommandOptionType.String, required: true },
        ],
      },
      {
        name: 'close', description: 'Close the current ticket', type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: 'ingame', description: 'In-game ban management',
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
    ],
  },
  {
    name: 'banlist', description: 'List all in-game banned players',
  },
];

function loadJSON(f, init) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { fs.writeFileSync(f, JSON.stringify(init, null, 2)); return init; }
}
function saveJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2)); }

const tickets = loadJSON(TICKETS_FILE, {});

function canTimeout(roles) {
  return roles?.has(ROLES.TRIAL_MOD) || roles?.has(ROLES.MOD) || roles?.has(ROLES.ADMIN) || roles?.has(ROLES.OWNER);
}
function canKick(roles) {
  return roles?.has(ROLES.MOD) || roles?.has(ROLES.ADMIN) || roles?.has(ROLES.OWNER);
}
function canBan(roles) {
  return roles?.has(ROLES.ADMIN) || roles?.has(ROLES.OWNER);
}
function isOwner(roles) {
  return roles?.has(ROLES.OWNER);
}

async function resolveRobloxId(username) {
  try {
    const res = await fetch('https://users.roblox.com/usernames/usernames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.data?.[0];
    return row?.id ? String(row.id) : null;
  } catch (err) {
    console.error('resolveRobloxId error:', err.message);
    return null;
  }
}

async function logToDiscord(guild, msg) {
  const ch = guild.channels.cache.get(LOG_CHANNEL);
  if (ch?.isTextBased()) await ch.send(msg);
}

async function createTicket(guild, user, type, reason) {
  const category = guild.channels.cache.get(TICKET_CATEGORY);
  if (!category || category.type !== ChannelType.GuildCategory) return null;

  const ticketId = String(Math.floor(100000 + Math.random() * 900000));
  const typeSlug = type === 'appeal' ? 'appeal' : 'other';
  const typeName = type === 'appeal' ? 'Appeal' : 'Other';

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

  await channel.send(`<@&${TICKET_PING_ROLE}> Ticket opened by ${user}\n**Type:** ${typeName}\n**Reason:** ${reason}`);

  tickets[user.id] = { channelId: channel.id, type, reason, createdAt: new Date().toISOString() };
  saveJSON(TICKETS_FILE, tickets);

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

  const transcriptFile = path.join(__dirname, `transcript-${channel.id}.json`);
  fs.writeFileSync(transcriptFile, JSON.stringify(msgs, null, 2));

  const logChannel = guild.channels.cache.get(LOG_CHANNEL);
  if (logChannel?.isTextBased()) {
    await logChannel.send({ content: `Ticket **${channel.name}** closed by ${closer.tag}`, files: [transcriptFile] });
  }
  fs.unlinkSync(transcriptFile);

  for (const [uid, d] of Object.entries(tickets)) { if (d.channelId === channel.id) { delete tickets[uid]; break; } }
  saveJSON(TICKETS_FILE, tickets);
  await channel.delete();
}

client.once('ready', async () => {
  client.user.setPresence({ activities: [], status: 'online' });
  console.log(`Logged in as ${client.user.tag}`);

  await client.application.commands.set([]);
  for (const guild of client.guilds.cache.values()) {
    const cmds = await guild.commands.set(COMMANDS);
    console.log(`Registered ${cmds.size} slash commands in ${guild.name}`);
  }
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
      await interaction.reply(`Timed out ${user} for ${DUR_NAMES[ms] || ms + 'ms'} - ${reason}`);
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
      if (!isOwner(roles)) { await interaction.reply({ content: 'No permission.', ephemeral: true }); return; }
      if (interaction.channel?.parentId !== TICKET_CATEGORY) {
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
      let user = interaction.options.getString('user', true).trim();
      const reason = interaction.options.getString('reason', true).trim();
      const actor = `${interaction.user.tag} (${interaction.user.id})`;

      await interaction.deferReply();

      let id = await resolveRobloxId(user);

      if (sub === 'ban') {
        const { error } = await supabase
          .from('ingame_bans')
          .upsert({ name: user, roblox_id: id, reason, banned_by: actor, banned_by_id: interaction.user.id }, { onConflict: 'name' });
        if (error) { console.error('supabase insert error:', error.message); await interaction.editReply('DB error, try again.'); return; }
        await logToDiscord(interaction.guild, `**"${user}"** (${id ?? 'unknown id'}) banned by **"${interaction.user.tag}"** for Reason: **"${reason}"**`);
        await interaction.editReply(`Banned **${user}** in-game${id ? ` (id: ${id})` : ''} - ${reason}`);
        return;
      }

      if (sub === 'unban') {
        const { data: existing } = await supabase
          .from('ingame_bans')
          .select('name, roblox_id')
          .eq('name', user)
          .single();
        if (existing) {
          user = existing.name;
          id = existing.roblox_id ?? id;
        }
        const { error } = await supabase
          .from('ingame_bans')
          .delete()
          .eq('name', user);
        if (error) { console.error('supabase delete error:', error.message); await interaction.editReply('DB error, try again.'); return; }
        await logToDiscord(interaction.guild, `**"${user}"** (${id ?? 'unknown id'}) unbanned by **"${interaction.user.tag}"**`);
        await interaction.editReply(`Unbanned **${user}** in-game${id ? ` (id: ${id})` : ''}`);
        return;
      }
    }
  }

  if (commandName === 'banlist') {
    const { data, error } = await supabase
      .from('ingame_bans')
      .select('name, roblox_id, reason, banned_by, created_at')
      .order('created_at', { ascending: false });

    if (error) { console.error('supabase select error:', error.message); await interaction.reply({ content: 'DB error, try again.', ephemeral: true }); return; }

    if (!data || data.length === 0) {
      await interaction.reply({ content: 'No in-game bans yet.', ephemeral: true });
      return;
    }

const lines = data.slice(0, 30).map((b, i) =>
      `${i + 1}. **${b.name}**${b.roblox_id ? ` (id: ${b.roblox_id})` : ''} — ${b.reason} — by ${b.banned_by?.split(' ')[0] ?? 'unknown'} — <t:${Math.floor(new Date(b.created_at).getTime() / 1000)}>`
    );
    const embed = new EmbedBuilder()
      .setColor(0x2c2323)
      .setTitle(`In-game bans (${data.length}${data.length > 30 ? ', showing first 30' : ''})`)
      .setDescription(lines.join('\n'));

    await interaction.reply({ content: '', ephemeral: true, embeds: [embed] });

    return;
  }
});

client.login(process.env.DISCORD_TOKEN);
