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
import setupStarboard from './features/starboard';
import {
  startSweepLoop,
  handleMessage,
  handleAutoDeleteInteraction,
  autoDeleteCommand,
  loadAutoDeleteRules,
} from './features/autodelete';
import {
  modLogCommand,
  handleModLogInteraction,
  logNewMessage,
  logDeletedMessage,
  logBulkDelete,
  loadModLogConfigs,
} from './features/modlog';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ── Command collection ────────────────────────────────────────
const commands = new Collection<string, any>();
commands.set(starboardCommand.data.name, starboardCommand);
// autodelete is handled directly via handleAutoDeleteInteraction,
// so it doesn't need an entry in the collection.

// ── Ready ─────────────────────────────────────────────────────
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // Register ALL slash commands in one PUT call
  const rest = new REST().setToken(process.env.BOT_TOKEN!);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!),
    {
      body: [
        starboardCommand.data.toJSON(),
        autoDeleteCommand.toJSON(),
        modLogCommand.toJSON(),         // ← modlog registered
      ],
    },
  );
  console.log('✅ Slash commands registered');

  setupStarboard(client);
  await loadAutoDeleteRules();  // ← restore autodelete rules from DB
  loadModLogConfigs();           // ← restore mod-log config from DB
  startSweepLoop(client);               // ← starts the 60s sweep loop
});

// ── Messages ──────────────────────────────────────────────────
client.on('messageCreate', (message) => {
  handleMessage(message);       // auto-delete scheduling
  if (!message.partial) logNewMessage(message);  // mod-log on send
});

// Log individually deleted messages to mod-log
client.on('messageDelete', (message) => {
  logDeletedMessage(message);
});

// Log bulk deletes (e.g. from /autodelete purge)
client.on('messageDeleteBulk', (messages, channel) => {
  logBulkDelete(messages, channel as TextChannel);
});

// ── Interactions ──────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Route /autodelete to its own handler
  if (interaction.commandName === 'autodelete') {
    await handleAutoDeleteInteraction(interaction);
    return;
  }

  if (interaction.commandName === 'modlog') {
    await handleModLogInteraction(interaction);
    return;
  }

  // All other commands go through the collection
  const command = commands.get(interaction.commandName);
  if (!command) return;
  await command.execute(interaction as ChatInputCommandInteraction);
});

client.login(process.env.BOT_TOKEN);