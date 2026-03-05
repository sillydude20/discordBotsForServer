// src/commands/say.ts
// ─────────────────────────────────────────────────────────────
// /say — send a plain message or embed as the bot
//
// Subcommands:
//   /say message <text> [channel]         — plain text message
//   /say embed <title> [description] [color] [channel]  — embed message
// ─────────────────────────────────────────────────────────────

import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  EmbedBuilder,
  TextChannel,
  PermissionFlagsBits,
} from 'discord.js';

export const sayCommand = new SlashCommandBuilder()
  .setName('say')
  .setDescription('Send a message as the bot (admin only)')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((sub) =>
    sub
      .setName('message')
      .setDescription('Send a plain text message')
      .addStringOption((opt) =>
        opt
          .setName('text')
          .setDescription('The message to send')
          .setRequired(true)
          .setMaxLength(2000),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to send to (defaults to current channel)')
          .setRequired(false),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('embed')
      .setDescription('Send an embed message')
      .addStringOption((opt) =>
        opt
          .setName('title')
          .setDescription('Embed title')
          .setRequired(true)
          .setMaxLength(256),
      )
      .addStringOption((opt) =>
        opt
          .setName('description')
          .setDescription('Embed body text (use \\n for new lines)')
          .setRequired(false)
          .setMaxLength(4096),
      )
      .addStringOption((opt) =>
        opt
          .setName('color')
          .setDescription('Hex color for the embed (e.g. #ff00ff)')
          .setRequired(false),
      )
      .addStringOption((opt) =>
        opt
          .setName('image')
          .setDescription('URL of an image or gif to display at the bottom of the embed')
          .setRequired(false),
      )
      .addChannelOption((opt) =>
        opt
          .setName('channel')
          .setDescription('Channel to send to (defaults to current channel)')
          .setRequired(false),
      ),
  );

export async function handleSayInteraction(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (interaction.commandName !== 'say') return;
  if (!interaction.guild) return;

  const sub = interaction.options.getSubcommand();

  // Resolve target channel — fall back to the channel the command was used in
  const targetChannel =
    (interaction.options.getChannel('channel') as TextChannel | null) ??
    (interaction.channel as TextChannel);

  if (!targetChannel?.isTextBased()) {
    await interaction.reply({ content: '❌ That channel is not a text channel.', ephemeral: true });
    return;
  }

  // Check the bot can actually send there
  const botMember = interaction.guild.members.me;
  const perms = botMember?.permissionsIn(targetChannel);
  if (!perms?.has(PermissionFlagsBits.SendMessages)) {
    await interaction.reply({
      content: `❌ I don't have permission to send messages in <#${targetChannel.id}>.`,
      ephemeral: true,
    });
    return;
  }

  // /say message
  if (sub === 'message') {
    const text = interaction.options.getString('text', true)
      .replace(/\\n/g, '\n'); // allow \n in the input for line breaks

    await targetChannel.send({ content: text });
    await interaction.reply({
      content: `✅ Message sent to <#${targetChannel.id}>.`,
      ephemeral: true,
    });
    return;
  }

  // /say embed
  if (sub === 'embed') {
    const title       = interaction.options.getString('title', true);
    const description = interaction.options.getString('description')?.replace(/\\n/g, '\n') ?? null;
    const colorInput  = interaction.options.getString('color');

    // Parse color — default to a neutral dark if not provided or invalid
    let color = 0x2b2d31; // Discord dark background
    if (colorInput) {
      const cleaned = colorInput.replace(/^#/, '');
      if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
        color = parseInt(cleaned, 16);
      } else {
        await interaction.reply({
          content: '❌ Invalid hex color. Use a format like `#ff00ff`.',
          ephemeral: true,
        });
        return;
      }
    }

    const imageUrl = interaction.options.getString('image');

    if (imageUrl && !/^https?:\/\//i.test(imageUrl)) {
      await interaction.reply({
        content: '❌ Invalid image URL. Must start with `https://`.',
        ephemeral: true,
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setColor(color);

    if (description) embed.setDescription(description);
    if (imageUrl)    embed.setImage(imageUrl);

    await targetChannel.send({ embeds: [embed] });
    await interaction.reply({
      content: `✅ Embed sent to <#${targetChannel.id}>.`,
      ephemeral: true,
    });
    return;
  }
}