// src/features/quote.ts
// ─────────────────────────────────────────────────────────────
// Quote image generator — triggered two ways:
//   1. @bot reply    — reply to any message and @mention the bot
//   2. /quote @user  — slash command targeting a specific message
//
// Buttons on the output:
//   🎨 Background  — cycles through background styles
//   🌈 Color       — cycles accent/text colors
//   🔄 Regenerate  — re-fetches and rebuilds the image
//   B  Bold        — toggle bold quote text
//   NEW New quote   — pick a random message from that user
//
// Install required dependency:
//   npm install @napi-rs/canvas
// ─────────────────────────────────────────────────────────────

import {
  Client,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType,
  AttachmentBuilder,
  EmbedBuilder,
  Colors,
} from 'discord.js';
import { createCanvas, loadImage, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'path';

// ── Types ─────────────────────────────────────────────────────

interface QuoteState {
  authorId: string;
  authorName: string;
  authorAvatar: string;
  authorHandle: string;
  content: string;
  bgStyle: number;
  colorScheme: number;
  bold: boolean;
  guildId: string;
  channelId: string;
}

// ── Style definitions ─────────────────────────────────────────

const BG_STYLES = [
  { name: 'Dark',        bg: '#0d0d0d', card: '#141414' },
  { name: 'Midnight',    bg: '#0a0a1a', card: '#12122a' },
  { name: 'Forest',      bg: '#0a120a', card: '#101a10' },
  { name: 'Crimson',     bg: '#150505', card: '#1e0a0a' },
  { name: 'Slate',       bg: '#0f1117', card: '#171b26' },
];

const COLOR_SCHEMES = [
  { text: '#ffffff', accent: '#a78bfa', handle: '#6b7280' }, // purple
  { text: '#ffffff', accent: '#60a5fa', handle: '#6b7280' }, // blue
  { text: '#ffffff', accent: '#34d399', handle: '#6b7280' }, // green
  { text: '#ffffff', accent: '#f87171', handle: '#6b7280' }, // red
  { text: '#ffffff', accent: '#fbbf24', handle: '#6b7280' }, // gold
  { text: '#ffffff', accent: '#f472b6', handle: '#6b7280' }, // pink
];

// ── Canvas drawing ────────────────────────────────────────────

const WIDTH  = 900;
const HEIGHT = 400;
const AVATAR_SIZE = 160;

// Wrap text to fit within maxWidth, returns array of lines
function wrapText(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = word;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Draw a rounded rectangle path
function roundRect(
  ctx: SKRSContext2D,
  x: number, y: number,
  w: number, h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export async function generateQuoteImage(state: QuoteState): Promise<Buffer> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx    = canvas.getContext('2d');

  const bg     = BG_STYLES[state.bgStyle % BG_STYLES.length];
  const scheme = COLOR_SCHEMES[state.colorScheme % COLOR_SCHEMES.length];

  // ── Background ─────────────────────────────────────────────
  ctx.fillStyle = bg.bg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle radial vignette
  const vignette = ctx.createRadialGradient(
    WIDTH / 2, HEIGHT / 2, HEIGHT * 0.2,
    WIDTH / 2, HEIGHT / 2, HEIGHT * 0.9,
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.6)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Card panel
  ctx.fillStyle = bg.card;
  roundRect(ctx, 30, 30, WIDTH - 60, HEIGHT - 60, 20);
  ctx.fill();

  // Left accent bar
  ctx.fillStyle = scheme.accent;
  roundRect(ctx, 30, 30, 6, HEIGHT - 60, 3);
  ctx.fill();

  // ── Avatar (circular, left side) ──────────────────────────
  const avatarX = 80;
  const avatarY = HEIGHT / 2 - AVATAR_SIZE / 2;

  try {
    const avatarImg = await loadImage(state.authorAvatar + '?size=256');

    // Circular clip
    ctx.save();
    ctx.beginPath();
    ctx.arc(
      avatarX + AVATAR_SIZE / 2,
      avatarY + AVATAR_SIZE / 2,
      AVATAR_SIZE / 2,
      0, Math.PI * 2,
    );
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, avatarX, avatarY, AVATAR_SIZE, AVATAR_SIZE);
    ctx.restore();

    // Accent ring around avatar
    ctx.beginPath();
    ctx.arc(
      avatarX + AVATAR_SIZE / 2,
      avatarY + AVATAR_SIZE / 2,
      AVATAR_SIZE / 2 + 3,
      0, Math.PI * 2,
    );
    ctx.strokeStyle = scheme.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
  } catch {
    // Avatar failed to load — draw a placeholder circle
    ctx.beginPath();
    ctx.arc(avatarX + AVATAR_SIZE / 2, avatarY + AVATAR_SIZE / 2, AVATAR_SIZE / 2, 0, Math.PI * 2);
    ctx.fillStyle = scheme.accent + '44';
    ctx.fill();
    ctx.strokeStyle = scheme.accent;
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // ── Quote text ────────────────────────────────────────────
  const textX     = avatarX + AVATAR_SIZE + 40;
  const textMaxW  = WIDTH - textX - 60;
  const fontSize  = state.content.length > 120 ? 26 : state.content.length > 60 ? 32 : 38;
  const fontWeight = state.bold ? 'bold' : 'normal';

  ctx.font        = `${fontWeight} ${fontSize}px serif`;
  ctx.fillStyle   = scheme.text;
  ctx.textBaseline = 'top';

  // Opening quote mark
  ctx.font      = `bold ${fontSize * 2.5}px serif`;
  ctx.fillStyle = scheme.accent + '44';
  ctx.fillText('"', textX - 8, 55);

  // Quote lines
  ctx.font      = `${fontWeight} ${fontSize}px serif`;
  ctx.fillStyle = scheme.text;
  const lines   = wrapText(ctx, state.content, textMaxW);
  const lineH   = fontSize * 1.45;
  const totalH  = lines.length * lineH;
  const startY  = HEIGHT / 2 - totalH / 2 - 20;

  lines.forEach((line, i) => {
    ctx.fillText(line, textX, startY + i * lineH);
  });

  // ── Author name + handle ──────────────────────────────────
  const authorY = startY + totalH + 28;

  ctx.font      = `bold 20px sans-serif`;
  ctx.fillStyle = scheme.accent;
  ctx.fillText(`- ${state.authorName}`, textX, authorY);

  ctx.font      = `16px sans-serif`;
  ctx.fillStyle = scheme.handle;
  ctx.fillText(`@${state.authorHandle}`, textX, authorY + 28);

  // ── Watermark ─────────────────────────────────────────────
  ctx.font      = `13px sans-serif`;
  ctx.fillStyle = '#ffffff18';
  ctx.textAlign = 'right';
  ctx.fillText(`Quote`, WIDTH - 50, HEIGHT - 55);

  return canvas.toBuffer('image/png');
}

// ── Button row builder ────────────────────────────────────────

function buildButtons(state: QuoteState): ActionRowBuilder<ButtonBuilder> {
  const bg     = BG_STYLES[state.bgStyle % BG_STYLES.length];
  const scheme = COLOR_SCHEMES[state.colorScheme % COLOR_SCHEMES.length];

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('quote_bg')
      .setEmoji('🎨')
      .setStyle(ButtonStyle.Secondary)
      .setLabel(bg.name),
    new ButtonBuilder()
      .setCustomId('quote_color')
      .setEmoji('🌈')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('quote_regen')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('quote_bold')
      .setLabel('B')
      .setStyle(state.bold ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('quote_new')
      .setLabel('New Quote')
      .setStyle(ButtonStyle.Success),
  );
}

// ── Send/update quote message ─────────────────────────────────

async function sendQuote(
  target: Message | ButtonInteraction,
  state: QuoteState,
  edit = false,
): Promise<void> {
  const buffer     = await generateQuoteImage(state);
  const attachment = new AttachmentBuilder(buffer, { name: 'quote.png' });
  const buttons    = buildButtons(state);

  const payload = {
    files: [attachment],
    components: [buttons],
  };

  if (edit && target instanceof ButtonInteraction) {
    await target.update(payload as any);
  } else if (target instanceof ButtonInteraction) {
    await target.reply(payload as any);
  } else {
    await target.reply(payload as any);
  }
}

// ── Fetch a random recent message from a user ─────────────────

async function fetchRandomUserMessage(
  originalMessage: Message,
  userId: string,
): Promise<string | null> {
  try {
    const messages = await originalMessage.channel.messages.fetch({ limit: 100 });
    const userMsgs = messages.filter(
      (m) =>
        m.author.id === userId &&
        m.id !== originalMessage.id &&
        m.content.length > 10 &&
        !m.content.startsWith('/'),
    );
    if (!userMsgs.size) return null;
    const arr = [...userMsgs.values()];
    return arr[Math.floor(Math.random() * arr.length)].content;
  } catch {
    return null;
  }
}

// ── State store (in-memory, keyed by quote message ID) ────────
const quoteStates = new Map<string, QuoteState>();

// ── Handle @mention trigger ───────────────────────────────────

export async function handleQuoteMention(
  message: Message,
  client: Client,
): Promise<void> {
  // Only act if the bot is mentioned
  if (!message.mentions.has(client.user!.id)) return;
  // Must be a reply to another message
  if (!message.reference?.messageId) return;

  try {
    const quoted = await message.channel.messages.fetch(message.reference.messageId);
    if (!quoted.content || quoted.content.length < 2) {
      await message.reply({ content: '❌ That message has no text to quote.' });
      return;
    }

    const member = message.guild
      ? await message.guild.members.fetch(quoted.author.id).catch(() => null)
      : null;

    const state: QuoteState = {
      authorId:     quoted.author.id,
      authorName:   member?.displayName ?? quoted.author.displayName,
      authorHandle: quoted.author.username,
      authorAvatar: quoted.author.displayAvatarURL({ extension: 'png', size: 256 }),
      content:      quoted.content,
      bgStyle:      0,
      colorScheme:  0,
      bold:         false,
      guildId:      message.guild?.id ?? '',
      channelId:    message.channelId,
    };

    const sent = await message.reply({
      content: '',
      files: [new AttachmentBuilder(await generateQuoteImage(state), { name: 'quote.png' })],
      components: [buildButtons(state)],
    });

    quoteStates.set(sent.id, state);
    setupButtonCollector(sent, state, message);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[quote] mention error:', msg);
  }
}

// ── Button collector ──────────────────────────────────────────

function setupButtonCollector(
  quoteMessage: Message,
  initialState: QuoteState,
  sourceMessage: Message,
): void {
  const collector = quoteMessage.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30 * 60 * 1000, // 30 minutes
  });

  collector.on('collect', async (interaction: ButtonInteraction) => {
    const state = quoteStates.get(quoteMessage.id) ?? initialState;
    const next  = { ...state };

    switch (interaction.customId) {
      case 'quote_bg':
        next.bgStyle = (state.bgStyle + 1) % BG_STYLES.length;
        break;

      case 'quote_color':
        next.colorScheme = (state.colorScheme + 1) % COLOR_SCHEMES.length;
        break;

      case 'quote_bold':
        next.bold = !state.bold;
        break;

      case 'quote_regen':
        // Rebuild with same settings
        break;

      case 'quote_new': {
        const newContent = await fetchRandomUserMessage(sourceMessage, state.authorId);
        if (!newContent) {
          await interaction.reply({
            content: "❌ Couldn't find another message from that user in recent history.",
            ephemeral: true,
          });
          return;
        }
        next.content = newContent;
        break;
      }

      default:
        return;
    }

    quoteStates.set(quoteMessage.id, next);

    try {
      const buffer     = await generateQuoteImage(next);
      const attachment = new AttachmentBuilder(buffer, { name: 'quote.png' });
      const buttons    = buildButtons(next);
      await interaction.update({ files: [attachment], components: [buttons] } as any);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.reply({ content: `❌ Failed to update: ${msg}`, ephemeral: true });
    }
  });

  collector.on('end', async () => {
    quoteStates.delete(quoteMessage.id);
    // Disable buttons after 30 minutes
    try {
      const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buildButtons(initialState).components.map((b) =>
          ButtonBuilder.from(b as any).setDisabled(true),
        ),
      );
      await quoteMessage.edit({ components: [disabledRow] });
    } catch { /* message may have been deleted */ }
  });
}