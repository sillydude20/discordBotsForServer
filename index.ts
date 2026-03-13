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
  Message,
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
import { handleQuoteRequest, quoteMsgIds } from './features/quote';
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
  generateMarkov,
  loadMarkovConfig,
} from './features/markov';
import { sayCommand, handleSayInteraction } from './commands/say';
// top of index.ts with other imports
import {
  activityCommand,
  handleActivityInteraction,
  handleVoiceStateUpdate,
  handleActivityMessage,   // NEW — replaces direct incrementMessageCount call
  loadActivityConfig,      // NEW
  startVoiceFlushLoop,     // NEW
} from './features/activity';
// import { incrementMessageCount } from './utils/database';

// ── Client ────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
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
        sayCommand.toJSON(),
        activityCommand.toJSON(),
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
  loadActivityConfig("1477702227899715596");
  startVoiceFlushLoop();
});

// ── Bot mention handler ───────────────────────────────────────
// Called when a message @mentions the bot.
// Handles two cases:
//
//   1. Reply to a human message + @bot
//        → generate a quote image of the replied-to message
//
//   2. Reply to a bot message + @bot
//        a. If the bot message is a quote image → do nothing
//        b. Otherwise → reply with a fresh markov generation

async function handleBotMention(message: Message): Promise<void> {
  if (!message.guild) return;
  if (!message.reference?.messageId) return;

  let target: Message;
  try {
    target = await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return;
  }

  const contentWithoutMention = message.content
    .replace(`<@${client.user!.id}>`, '')
    .replace(`<@!${client.user!.id}>`, '')
    .trim();
  const isBareMention = contentWithoutMention.length === 0;

  // Replying to a bot message
  if (target.author.id === client.user!.id) {
    const isQuoteImage =
      quoteMsgIds.has(target.id) ||
      (target.attachments.size > 0 && !target.content);

    if (isQuoteImage) return;

    if (isBareMention) {
      await handleQuoteRequest(message, target, client);
      return;
    }

    const generated = generateMarkov(message.guild.id);
    if (generated) await message.reply(generated);
    return;
  }

  // Replying to a human message → quote it
  await handleQuoteRequest(message, target, client);
}

// ── Messages ──────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.partial) return;
  if (message.author.bot) return;

  handleMessage(message);
  logNewMessage(message);
  handleMarkovMessage(message, client);

  if (message.guild) {
        handleActivityMessage(message.guild.id, message.author.id, message.channelId);
      }

  if (message.mentions.has(client.user!.id)) {
    await handleBotMention(message);
  }
});

client.on('messageDelete', (message) => {
  logDeletedMessage(message);
});

client.on('messageDeleteBulk', (messages, channel) => {
  logBulkDelete(messages, channel as TextChannel);
});

client.on('messageUpdate', (oldMessage, newMessage) => {
  logEditedMessage(oldMessage, newMessage);
});

// ── Voice ─────────────────────────────────────────────────────
client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(oldState, newState);
});

// ── Members ───────────────────────────────────────────────────
client.on('guildMemberAdd', (member) => {
  logMemberJoin(member as any);
});

client.on('guildMemberRemove', (member) => {
  logMemberLeave(member as any);
});

client.on('guildMemberUpdate', (oldMember, newMember) => {
  handleBoostChange(oldMember as any, newMember as any, client);
  logRoleUpdate(oldMember as any, newMember as any);
});

// ── Interactions ──────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  // User ID copy button
  if (interaction.isButton() && interaction.customId.startsWith('copy_uid_')) {
    const userId = interaction.customId.replace('copy_uid_', '');
    await interaction.reply({ content: `\`${userId}\``, ephemeral: true });
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  await logCommandUsage(interaction);

  const cmd = interaction.commandName;

  // ── Public commands ──────────────────────────────────────────

  if (cmd === 'confession') {
    await confessionCommand.execute(interaction);
    return;
  }

  if (cmd === 'setuprole') {
    await handleSetupRoleInteraction(interaction);
    return;
  }

  // Internally checks boost status
  if (cmd === 'booster') {
    await handleBoosterInteraction(interaction, client);
    return;
  }

  // Public stats/leaderboard/graph — import is gated inside the handler
  if (cmd === 'activity') {
    await handleActivityInteraction(interaction);
    return;
  }

  // ── Admin-gated commands ─────────────────────────────────────

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

  if (cmd === 'say') {
    if (!await checkAdminRole(interaction)) return;
    await handleSayInteraction(interaction);
    return;
  }

  // Starboard + confession config (collection-based commands)
  const command = commands.get(cmd);
  if (!command) return;
  if (!await checkAdminRole(interaction)) return;
  await command.execute(interaction as ChatInputCommandInteraction);
});

client.login(process.env.BOT_TOKEN!);