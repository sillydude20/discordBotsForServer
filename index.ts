import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  REST,
  Routes,
  ChatInputCommandInteraction,
  TextChannel,
} from 'discord.js';
import * as starboardCommand from './commands/starboard';
import * as confessionCommand from './commands/confession';
import setupStarboard from './features/starboard';
import {
  startSweepLoop,
  handleMessage,
  handleAutoDeleteInteraction,
  autoDeleteCommand,
  loadAutoDeleteRules,
} from './features/autodelete';
import {
  boosterCommand,
  boosterAdminCommand,
  handleBoosterInteraction,
  handleBoosterAdminInteraction,
  handleBoostChange,
} from './features/booster';
import {
  modLogCommand,
  handleModLogInteraction,
  logNewMessage,
  logDeletedMessage,
  logEditedMessage,
  logBulkDelete,
  logMemberJoin,
  logMemberLeave,
  logRoleUpdate,
  loadModLogConfigs,
  logCommandUsage,
  checkAuditLogPermission,
} from './features/modlog';
import { handleQuoteMention } from './features/quote';
import {
  setupRoleCommand,
  handleSetupRoleInteraction,
  checkAdminRole,
  loadAdminRoles,
} from './utils/rolecheck';
import {
  markovCommand,
  handleMarkovInteraction,
  handleMarkovMessage,
  loadMarkovConfig,
} from './features/markov';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── Command collection ────────────────────────────────────────
const commands = new Collection<string, any>();
commands.set(starboardCommand.data.name, starboardCommand);
commands.set(confessionCommand.data.name, confessionCommand);

// ── Ready ─────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  const rest = new REST().setToken(process.env.BOT_TOKEN!);
  await rest.put(
    Routes.applicationCommands(process.env.CLIENT_ID!),
    {
      body: [
        starboardCommand.data.toJSON(),
        confessionCommand.data.toJSON(),
        autoDeleteCommand.toJSON(),
        modLogCommand.toJSON(),
        boosterCommand.toJSON(),
        boosterAdminCommand.toJSON(),
        setupRoleCommand.toJSON(),
        markovCommand.toJSON(),
      ],
    },
  );
  console.log('✅ Slash commands registered');

  setupStarboard(client);
  loadAdminRoles();
  await loadAutoDeleteRules();
  loadModLogConfigs();
  loadMarkovConfig();
  await checkAuditLogPermission(client);
  startSweepLoop(client);
});

// ── Messages ──────────────────────────────────────────────────
client.on('messageCreate', (message) => {
  handleMessage(message);
  if (!message.partial) logNewMessage(message);
  if (!message.partial) handleMarkovMessage(message, client);
  if (!message.partial && message.content.includes(`<@${client.user!.id}>`)) {
  handleQuoteMention(message, client);
}
});

client.on('messageDelete', (message) => {
  logDeletedMessage(message);
});

client.on('messageDeleteBulk', (messages, channel) => {
  logBulkDelete(messages, channel as TextChannel);
});

// ── Interactions ──────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  // ── User ID button handler ──────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith('copy_uid_')) {
    const userId = interaction.customId.replace('copy_uid_', '');
    await interaction.reply({ content: `\`${userId}\``, ephemeral: true });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  // Log every slash command before dispatching
  await logCommandUsage(interaction);

  const cmd = interaction.commandName;

  // /confession — open to everyone, no admin role required
  if (cmd === 'confession') {
    await confessionCommand.execute(interaction);
    return;
  }

  // /setuprole — only needs ManageGuild
  if (cmd === 'setuprole') {
    await handleSetupRoleInteraction(interaction);
    return;
  }

  // /booster — open to all, internally checks if user is a booster
  if (cmd === 'booster') {
    await handleBoosterInteraction(interaction, client);
    return;
  }

  // Everything below requires the admin role ─────────────────

  if (cmd === 'autodelete') {
    if (!await checkAdminRole(interaction)) return;
    await handleAutoDeleteInteraction(interaction);
    return;
  }

  if (cmd === 'modlog') {
    if (!await checkAdminRole(interaction)) return;
    await handleModLogInteraction(interaction);
    return;
  }

  if (cmd === 'boosteradmin') {
    if (!await checkAdminRole(interaction)) return;
    await handleBoosterAdminInteraction(interaction, client);
    return;
  }

  if (cmd === 'markov') {
    if (!await checkAdminRole(interaction)) return;
    await handleMarkovInteraction(interaction);
    return;
  }

  // Starboard and any other collection commands
  const command = commands.get(cmd);
  if (!command) return;
  if (!await checkAdminRole(interaction)) return;
  await command.execute(interaction as ChatInputCommandInteraction);
});

// ── Log edited messages ───────────────────────────────────────
client.on('messageUpdate', (oldMessage, newMessage) => {
  logEditedMessage(oldMessage, newMessage);
});

// ── Log member join / leave ───────────────────────────────────
client.on('guildMemberAdd', (member) => {
  logMemberJoin(member as any);
});

client.on('guildMemberRemove', (member) => {
  logMemberLeave(member as any);
});

// ── Boost detection & role updates ───────────────────────────
client.on('guildMemberUpdate', (oldMember, newMember) => {
  handleBoostChange(oldMember as any, newMember as any, client);
  logRoleUpdate(oldMember as any, newMember as any);
});

client.login(process.env.BOT_TOKEN);