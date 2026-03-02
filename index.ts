import 'dotenv/config'
import { Client, GatewayIntentBits, Partials, Collection, REST, Routes, ChatInputCommandInteraction } from "discord.js";
import * as starboardCommand from "./commands/starboard";
import setupStarboard from "./features/starboard";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Register commands in a collection
const commands = new Collection<string, any>();
commands.set(starboardCommand.data.name, starboardCommand);

client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);

  // Register slash commands with Discord
  const rest = new REST().setToken(process.env.BOT_TOKEN!);
  await rest.put(
    Routes.applicationGuildCommands(process.env.CLIENT_ID!, process.env.GUILD_ID!),
    { body: [starboardCommand.data.toJSON()] }
  );

  console.log("✅ Slash commands registered");
  setupStarboard(client);
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;
  await command.execute(interaction as ChatInputCommandInteraction);
});

client.login(process.env.BOT_TOKEN);