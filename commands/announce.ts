import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ModalSubmitInteraction,
} from 'discord.js';

export const announceCommand = new SlashCommandBuilder()
  .setName('announce')
  .setDescription('Send a styled embed message');

export async function handleAnnounce(interaction: ChatInputCommandInteraction) {
  const modal = new ModalBuilder()
    .setCustomId('announce_modal')
    .setTitle('Create Announcement Embed');

  const titleInput = new TextInputBuilder()
    .setCustomId('embed_title')
    .setLabel('Title')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(256);

  const descInput = new TextInputBuilder()
    .setCustomId('embed_desc')
    .setLabel('Description')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(4000);

  const colorInput = new TextInputBuilder()
    .setCustomId('embed_color')
    .setLabel('Color (hex, e.g. #5865F2)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setPlaceholder('#5865F2');

  const fieldsInput = new TextInputBuilder()
    .setCustomId('embed_fields')
    .setLabel('Fields (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(false)
    .setPlaceholder('Field Name | Field Value\nAnother Field | Another Value');

  const footerInput = new TextInputBuilder()
    .setCustomId('embed_footer')
    .setLabel('Footer text (optional)')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(colorInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(fieldsInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(footerInput),
  );

  // showModal must be called before any await
  await interaction.showModal(modal);
}

export async function handleAnnounceModal(interaction: ModalSubmitInteraction) {
  await interaction.deferReply({ ephemeral: true });

  const title = interaction.fields.getTextInputValue('embed_title');
  const desc = interaction.fields.getTextInputValue('embed_desc');
  const colorRaw = interaction.fields.getTextInputValue('embed_color').trim();
  const fieldsRaw = interaction.fields.getTextInputValue('embed_fields').trim();
  const footer = interaction.fields.getTextInputValue('embed_footer').trim();

  // Parse color
  let color: number = 0x5865F2;
  if (colorRaw) {
    const parsed = parseInt(colorRaw.replace('#', ''), 16);
    if (!isNaN(parsed)) color = parsed;
  }

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(desc)
    .setColor(color);

  // Parse fields: each line is "Name | Value"
  if (fieldsRaw) {
    const lines = fieldsRaw.split('\n').filter(l => l.includes('|'));
    for (const line of lines) {
      const [name, ...rest] = line.split('|');
      const value = rest.join('|').trim(); // allow | in values
      if (name && value) {
        embed.addFields({ name: name.trim(), value });
      }
    }
  }

  if (footer) embed.setFooter({ text: footer });

  const channel = interaction.channel;
  if (!channel || typeof (channel as any).send !== 'function') {
    await interaction.editReply({ content: '⚠️ Unable to send embed in this channel.' });
    return;
  }

  await (channel as any).send({ embeds: [embed] });
  await interaction.editReply({ content: '✅ Embed sent!' });
}