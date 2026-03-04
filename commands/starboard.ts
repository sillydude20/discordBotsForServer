import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType
} from "discord.js";
import { getStarboardConfig, setStarboardConfig } from "../utils/database";




export const data = new SlashCommandBuilder()
  .setName("starboard")
  .setDescription("Configure the starboard")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub.setName("setchannel")
      .setDescription("Set the starboard output channel")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("The channel to post starred messages in")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("setthreshold")
      .setDescription("Set how many stars are needed")
      .addIntegerOption(opt =>
        opt.setName("amount")
          .setDescription("Number of stars required")
          .setMinValue(1)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("addchannel")
      .setDescription("Allow a channel to be starred from")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("Channel to allow")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("removechannel")
      .setDescription("Remove a channel from the allowed list")
      .addChannelOption(opt =>
        opt.setName("channel")
          .setDescription("Channel to remove")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName("status")
      .setDescription("View current starboard configuration")
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Server owner only

  const guildId = interaction.guildId!;
  const sub = interaction.options.getSubcommand();

  // Load existing config or start fresh
  const config = getStarboardConfig(guildId) ?? {
    channelId: "",
    threshold: 3,
    allowedChannels: []
  };

  if (sub === "setchannel") {
    const channel = interaction.options.getChannel("channel", true);
    config.channelId = channel.id;
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ Starboard channel set to <#${channel.id}>`, ephemeral: true });

  } else if (sub === "setthreshold") {
    const amount = interaction.options.getInteger("amount", true);
    config.threshold = amount;
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ Star threshold set to **${amount}** ⭐`, ephemeral: true });

  } else if (sub === "addchannel") {
    const channel = interaction.options.getChannel("channel", true);
    if (config.allowedChannels.includes(channel.id)) {
      await interaction.reply({ content: `⚠️ <#${channel.id}> is already in the allowed list.`, ephemeral: true });
      return;
    }
    config.allowedChannels.push(channel.id);
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ <#${channel.id}> added to allowed channels.`, ephemeral: true });

  } else if (sub === "removechannel") {
    const channel = interaction.options.getChannel("channel", true);
    config.allowedChannels = config.allowedChannels.filter(id => id !== channel.id);
    setStarboardConfig(guildId, config);
    await interaction.reply({ content: `✅ <#${channel.id}> removed from allowed channels.`, ephemeral: true });

  } else if (sub === "status") {
    if (!config.channelId) {
      await interaction.reply({ content: "⚠️ Starboard is not configured yet. Use `/starboard setchannel` first.", ephemeral: true });
      return;
    }
    const channels = config.allowedChannels.length > 0
      ? config.allowedChannels.map(id => `<#${id}>`).join(", ")
      : "All channels";
    await interaction.reply({
      content: `📌 **Starboard Config**\nChannel: <#${config.channelId}>\nThreshold: **${config.threshold}** ⭐\nAllowed channels: ${channels}`,
      ephemeral: true
    });
  }
}