import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  REST,
  Routes,
  ChatInputCommandInteraction,
} from 'discord.js';
import * as starboardCommand from './commands/starboard';
import setupStarboard from './features/starboard';
import {
  startSweepLoop,
  handleMessage,
  handleAutoDeleteInteraction,
  autoDeleteCommand,
} from './features/autodelete';

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
        autoDeleteCommand.toJSON(),       // ← autodelete added here
      ],
    },
  );
  console.log('✅ Slash commands registered');

  setupStarboard(client);
  startSweepLoop(client);               // ← starts the 60s sweep loop
});

// ── Messages ──────────────────────────────────────────────────
client.on('messageCreate', (message) => {
  handleMessage(message);               // ← schedules real-time deletion
});

// ── Interactions ──────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Route /autodelete to its own handler
  if (interaction.commandName === 'autodelete') {
    await handleAutoDeleteInteraction(interaction);
    return;
  }

  // All other commands go through the collection
  const command = commands.get(interaction.commandName);
  if (!command) return;
  await command.execute(interaction as ChatInputCommandInteraction);
});

client.login(process.env.BOT_TOKEN);