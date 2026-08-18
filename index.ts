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

import { handleGifOverlay } from './features/gifOverlay';

import { handleOllamaReply } from './features/ollama'; 

import { announceCommand, handleAnnounce, handleAnnounceModal } from './commands/announce';
// Add to imports at the top
import { handleXFixer } from './features/xFixer';
import { handleStickyRolesLeave, handleStickyRolesJoin } from './features/sticky';
import {
  trackLastMessage,
  startDeadRoleSweep,
  handleDeadChannelReactivation,
} from './features/deadRoles';
import { limboCommand, unlimboCommand, handleLimboInteraction, handleUnlimboInteraction } from './commands/limbo';

import {
  warnCommand,
  warningsCommand,
  clearWarningsCommand,
  banCommand,
  handleWarnInteraction,
  handleWarningsInteraction,
  handleClearWarningsInteraction,
  handleBanInteraction,
} from './commands/moderation';

const AUTO_ROLE_GUILD_ID = '1469371127112536271';
const AUTO_ROLE_IDS = ['1477773684596019241', '1478598288096755984'];

// import { incrementMessageCount } from './utils/database';
const voiceWebhookCache = new Map<string, string>(); // channelId -> webhookId
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
        announceCommand.toJSON(),
        limboCommand.toJSON(),
        unlimboCommand.toJSON(),
        warnCommand.toJSON(),
        warningsCommand.toJSON(),
        clearWarningsCommand.toJSON(),
        banCommand.toJSON(),
      ],
    },
  );
  startDeadRoleSweep(client);
  console.log('✅ Slash commands registered');

  setupStarboard(client);
  loadAdminRoles();
  await loadAutoDeleteRules();
  loadModLogConfigs();
  loadMarkovConfig();
  await checkAuditLogPermission(client);
  startSweepLoop(client);
  for (const guild of client.guilds.cache.values()) {
  loadActivityConfig(guild.id);
}
  startVoiceFlushLoop();
});
  client.on('guildCreate', (guild) => {
  loadActivityConfig(guild.id);
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

  const contentWithoutMention = message.content
    .replace(`<@${client.user!.id}>`, '')
    .replace(`<@!${client.user!.id}>`, '')
    .trim();
  const isBareMention = contentWithoutMention.length === 0;

  // ── NEW: if they @mention the bot with text but no reply, ask Ollama ──
  if (!message.reference?.messageId) return;

  // ── existing reply-based logic below, unchanged ──
  let target: Message;
  try {
    target = await message.channel.messages.fetch(message.reference.messageId);
  } catch {
    return;
  }

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

  return;
  }

  // Replying to a human message → quote it
  await handleQuoteRequest(message, target, client);
}

async function handleVoiceTranscribe(message: Message): Promise<void> {
  const att = message.attachments.first();
  if (!att) return;

  const isVoiceMessage =
    att.name === "voice-message.ogg" ||
    (att.contentType?.startsWith("audio/ogg") ?? false);

  if (!isVoiceMessage) return;

  console.log(`[voiceTranscribe] Voice message from ${message.author.username}`);

  try {
    const audioRes = await fetch(att.url);
    const audioBuffer = await audioRes.arrayBuffer();

    const res = await fetch("http://localhost:5001/transcribe", {
      method: "POST",
      body: Buffer.from(audioBuffer),
      headers: { "Content-Type": "application/octet-stream" },
    });

    const { transcript } = await res.json() as { transcript: string };

    if (!transcript) {
      await message.reply("🎙️ I couldn't make out anything in that voice message.");
      return;
    }

    // Send via webhook so it appears with the user's avatar and name
    const channel = message.channel as TextChannel;
    let webhook;
    const cachedId = voiceWebhookCache.get(channel.id);
    const hooks = await channel.fetchWebhooks();
    webhook = cachedId ? hooks.get(cachedId) : hooks.find(h => h.owner?.id === client.user?.id);
    if (!webhook) {
      webhook = await channel.createWebhook({ name: 'Voice Transcribe' });
    }
    voiceWebhookCache.set(channel.id, webhook.id);

    const member = message.member;
    await webhook.send({
      content: `🎙️ ${transcript}`,
      username: member?.displayName ?? message.author.username,
      avatarURL: member?.displayAvatarURL({ size: 256 }) ?? message.author.displayAvatarURL({ size: 256 }),
      allowedMentions: { parse: [] },
    });

  } catch (e) {
    console.error("[voiceTranscribe] Error:", e);
    await message.reply("❌ Failed to transcribe the voice message.");
  }
}

// ── Messages ──────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.partial) return;
  if (message.author.bot) return;

  if (message.content.startsWith('!cum')) {
  await handleGifOverlay(message);
  return;
}
  if (message.content.startsWith('!roast')) {
  const target = message.mentions.users.first();
  if (!target) {
    await message.reply('Usage: `!roast @user`');
    return;
  }
  await handleOllamaReply(message, `<@${target.id}>`, target.toString());
  return;
}
  // ── X/Twitter fixer — runs before log so deleted msg isn't logged ──
  await handleXFixer(message, voiceWebhookCache); // reuses the same cache

  handleMessage(message);
  logNewMessage(message);
  handleMarkovMessage(message, client);
  await handleVoiceTranscribe(message);

  if (message.mentions.has(client.user!.id)) {
    await handleBotMention(message);
  }
  if (message.guild) {
  handleActivityMessage(message.guild.id, message.author.id, message.channelId);
  trackLastMessage(message.guild.id, message.author.id, message.createdTimestamp);
}

await handleDeadChannelReactivation(message); 

  
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
client.on('guildMemberAdd', async (member) => {
  logMemberJoin(member as any);
  handleStickyRolesJoin(member);
  if (member.guild.id === AUTO_ROLE_GUILD_ID) {
    try {
      await member.roles.add(AUTO_ROLE_IDS, 'Auto-assigned on join');
      console.log(`[autoRole] Assigned default roles to ${member.user.tag}`);
    } catch (e) {
      console.error('[autoRole] Failed to assign roles:', e);
    }
  }
});

client.on('guildMemberRemove', (member) => {
  logMemberLeave(member as any);
  handleStickyRolesLeave(member);
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

  if (interaction.isModalSubmit()) {
  if (interaction.customId === 'announce_modal') {
    await handleAnnounceModal(interaction);
    return;
  }
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

  if (cmd === 'announce') {
  if (!await checkAdminRole(interaction)) return;
  await handleAnnounce(interaction);
  return;
}

  if (cmd === 'limbo') {
  if (!await checkAdminRole(interaction)) return;
  await handleLimboInteraction(interaction);
  return;
}

if (cmd === 'unlimbo') {
  if (!await checkAdminRole(interaction)) return;
  await handleUnlimboInteraction(interaction);
  return;
}

if (cmd === 'warn') {
  if (!await checkAdminRole(interaction)) return;
  await handleWarnInteraction(interaction);
  return;
}

if (cmd === 'warnings') {
  if (!await checkAdminRole(interaction)) return;
  await handleWarningsInteraction(interaction);
  return;
}

if (cmd === 'clearwarnings') {
  if (!await checkAdminRole(interaction)) return;
  await handleClearWarningsInteraction(interaction);
  return;
}

if (cmd === 'ban') {
  if (!await checkAdminRole(interaction)) return;
  await handleBanInteraction(interaction);
  return;
}

  // Starboard + confession config (collection-based commands)
  const command = commands.get(cmd);
  if (!command) return;
  if (!await checkAdminRole(interaction)) return;
  await command.execute(interaction as ChatInputCommandInteraction);

  


});

client.login(process.env.BOT_TOKEN!);