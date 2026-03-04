// src/features/quote.ts
import {
  Client, Message, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ButtonInteraction, ComponentType, AttachmentBuilder,
} from 'discord.js';
import { createCanvas, loadImage, SKRSContext2D, Image } from '@napi-rs/canvas';
import { markovMsgIds } from './markov';
interface QuoteState {
  authorId: string; authorName: string; authorAvatar: string;
  authorHandle: string; content: string;
  grayscale: boolean; vertical: boolean; bold: boolean;
  guildId: string; channelId: string;
}

const RADIUS = 16;

// ── Emoji image cache ─────────────────────────────────────────
const emojiCache = new Map<string, Image | null>();

async function loadEmojiImage(emoji: string): Promise<Image | null> {
  if (emojiCache.has(emoji)) return emojiCache.get(emoji)!;
  try {
    const codePoint = [...emoji]
      .map(c => c.codePointAt(0)!.toString(16).padStart(4, '0'))
      .filter(c => c !== 'fe0f') // strip variation selector
      .join('-');
    const url = `https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/${codePoint}.png`;
    const img = await loadImage(url);
    emojiCache.set(emoji, img);
    return img;
  } catch {
    emojiCache.set(emoji, null);
    return null;
  }
}

// ── Split text into text/emoji runs ──────────────────────────
const EMOJI_REGEX = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;

interface TextRun {
  type: 'text' | 'emoji';
  value: string;
}

function splitIntoRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index! > last) {
      runs.push({ type: 'text', value: text.slice(last, match.index) });
    }
    runs.push({ type: 'emoji', value: match[0] });
    last = match.index! + match[0].length;
  }
  if (last < text.length) runs.push({ type: 'text', value: text.slice(last) });
  return runs;
}

// ── Measure a line accounting for emoji widths ────────────────
function measureLine(ctx: SKRSContext2D, text: string, fontSize: number): number {
  const runs = splitIntoRuns(text);
  let width = 0;
  for (const run of runs) {
    if (run.type === 'text') {
      width += ctx.measureText(run.value).width;
    } else {
      width += fontSize * 1.1;
    }
  }
  return width;
}

// ── Draw a line with inline emoji images ──────────────────────
async function drawLineWithEmoji(
  ctx: SKRSContext2D,
  line: string,
  x: number,
  y: number,
  fontSize: number,
  color: string,
  fontStyle: string,
) {
  const runs = splitIntoRuns(line);
  const emojiSize = fontSize * 0.9;
  let cursorX = x;

  ctx.fillStyle = color;

  for (const run of runs) {
    if (run.type === 'text') {
      ctx.font = fontStyle;
      ctx.fillText(run.value, cursorX, y);
      cursorX += ctx.measureText(run.value).width;
    } else {
      const img = await loadEmojiImage(run.value);
      if (img) {
        const emojiY = y - emojiSize * 0.05;
        ctx.drawImage(img, cursorX, emojiY, emojiSize, emojiSize);
        cursorX += emojiSize;
      } else {
        // Fallback: skip unrenderable emoji silently
        cursorX += fontSize * 0.8;
      }
    }
  }
}

// ── Clean Discord-specific syntax ────────────────────────────
// Custom Discord emojis and mentions can't be rendered as images,
// so convert them to readable text labels.
function cleanContent(content: string): string {
  return content
    .replace(/<a:([^:]+):\d+>/g, '[$1]')   // animated emoji
    .replace(/<:([^:]+):\d+>/g, '[$1]')    // static custom emoji
    .replace(/<@!?\d+>/g, '@user')          // user mentions
    .replace(/<@&\d+>/g, '@role')           // role mentions
    .replace(/<#\d+>/g, '#channel')         // channel mentions
    .trim();
}

// ── Text wrapping (emoji-aware) ───────────────────────────────
function wrapText(ctx: SKRSContext2D, text: string, maxW: number, fontSize: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (measureLine(ctx, word, fontSize) > maxW) {
      if (line) { lines.push(line); line = ''; }
      let partial = '';
      for (const char of word) {
        if (measureLine(ctx, partial + char, fontSize) > maxW) {
          lines.push(partial);
          partial = char;
        } else {
          partial += char;
        }
      }
      if (partial) line = partial;
      continue;
    }

    const test = line ? `${line} ${word}` : word;
    if (measureLine(ctx, test, fontSize) > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
}

function applyGrayscale(ctx: SKRSContext2D, x: number, y: number, w: number, h: number) {
  const d = ctx.getImageData(x, y, w, h); const data = d.data;
  for (let i = 0; i < data.length; i += 4) {
    const avg = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    data[i] = data[i+1] = data[i+2] = avg;
  }
  ctx.putImageData(d, x, y);
}

async function drawHorizontal(ctx: SKRSContext2D, state: QuoteState) {
  const W = 1200, H = 630, AW = 560, FW = 220;
  const TEXT_X = 670;
  const TEXT_W = W - TEXT_X - 60;
  const PAD_V = 50;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  try {
    const img = await loadImage(state.authorAvatar + '?size=4096');
    const scale = Math.max(AW / img.width, H / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, (AW - drawW) / 2, (H - drawH) / 2, drawW, drawH);
    if (state.grayscale) applyGrayscale(ctx, 0, 0, AW, H);
  } catch {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, AW, H);
  }

  const fg = ctx.createLinearGradient(AW - FW, 0, AW + 40, 0);
  fg.addColorStop(0, '#0a0a0a00');
  fg.addColorStop(1, '#0a0a0aff');
  ctx.fillStyle = fg;
  ctx.fillRect(AW - FW, 0, FW + 40, H);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const displayContent = cleanContent(state.content);

  let fs = 80;
  let lines: string[] = [];
  let lh = fs * 1.3;

  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3;
    lines = wrapText(ctx, displayContent, TEXT_W, fs);
    const totalH = lines.length * lh;
    if (totalH + 100 <= H - PAD_V * 2) break;
    fs -= 1;
  }

  const totalTextH = lines.length * lh;
  const blockH = totalTextH + 100;
  const startY = (H - blockH) / 2;
  const fontStyle = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;

  for (let i = 0; i < lines.length; i++) {
    await drawLineWithEmoji(ctx, lines[i], TEXT_X, startY + i * lh, fs, '#ffffff', fontStyle);
  }

  const authorY = startY + totalTextH + 20;
  const nameFontSize = Math.max(32, Math.floor(fs * 0.42));
  const handleFontSize = Math.max(24, Math.floor(fs * 0.32));

  ctx.font = `italic 600 ${nameFontSize}px sans-serif`;
  ctx.fillStyle = '#cccccc';
  ctx.fillText(`- ${state.authorName}`, TEXT_X, authorY);

  ctx.font = `400 ${handleFontSize}px sans-serif`;
  ctx.fillStyle = '#777777';
  ctx.fillText(`@${state.authorHandle}`, TEXT_X, authorY + nameFontSize + 6);

  ctx.font = '400 13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('if you see this your mom gay lol', W - 18, H - 16);
}

async function drawVertical(ctx: SKRSContext2D, state: QuoteState) {
  const W = 630, H = 1200, AH = 560, FH = 280;
  const TEXT_Y = 700;
  const TEXT_H = H - TEXT_Y - 60;
  const TEXT_X = 60;
  const TEXT_W = W - TEXT_X * 2;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  try {
    const img = await loadImage(state.authorAvatar + '?size=4096');
    const scale = Math.max(W / img.width, AH / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    ctx.drawImage(img, (W - drawW) / 2, (AH - drawH) / 2, drawW, drawH);
    if (state.grayscale) applyGrayscale(ctx, 0, 0, W, AH);
  } catch {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, W, AH);
  }

  const fg = ctx.createLinearGradient(0, AH - FH, 0, AH + 40);
  fg.addColorStop(0, '#0a0a0a00');
  fg.addColorStop(1, '#0a0a0aff');
  ctx.fillStyle = fg;
  ctx.fillRect(0, AH - FH, W, FH + 40);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const displayContent = cleanContent(state.content);

  let fs = 80;
  let lines: string[] = [];
  let lh = fs * 1.3;

  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3;
    lines = wrapText(ctx, displayContent, TEXT_W, fs);
    const totalH = lines.length * lh;
    if (totalH + 100 <= TEXT_H) break;
    fs -= 1;
  }

  const totalTextH = lines.length * lh;
  const blockH = totalTextH + 100;
  const startY = TEXT_Y + (TEXT_H - blockH) / 2;
  const fontStyle = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;

  for (let i = 0; i < lines.length; i++) {
    await drawLineWithEmoji(ctx, lines[i], TEXT_X, startY + i * lh, fs, '#ffffff', fontStyle);
  }

  const authorY = startY + totalTextH + 20;
  const nameFontSize = Math.max(32, Math.floor(fs * 0.42));
  const handleFontSize = Math.max(24, Math.floor(fs * 0.32));

  ctx.font = `italic 600 ${nameFontSize}px sans-serif`;
  ctx.fillStyle = '#cccccc';
  ctx.fillText(`- ${state.authorName}`, TEXT_X, authorY);

  ctx.font = `400 ${handleFontSize}px sans-serif`;
  ctx.fillStyle = '#777777';
  ctx.fillText(`@${state.authorHandle}`, TEXT_X, authorY + nameFontSize + 6);

  ctx.font = '400 13px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Quote', W - 18, H - 16);
}

function buildButtons(state: QuoteState): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('quote_grayscale')
      .setLabel(state.grayscale ? '🎨 Color' : '⬛ B&W').setStyle(state.grayscale ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_orientation')
      .setLabel(state.vertical ? '↔️ Horizontal' : '↕️ Vertical').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_bold')
      .setLabel('B').setStyle(state.bold ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_regen').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_new').setLabel('New Quote').setStyle(ButtonStyle.Success),
  );
}

async function fetchRandomUserMessage(source: Message, userId: string): Promise<string | null> {
  try {
    const msgs = await source.channel.messages.fetch({ limit: 100 });
    const f = msgs.filter(m =>
      m.author.id === userId &&
      m.id !== source.id &&
      m.content.length > 10 &&
      !m.content.startsWith('/'),
    );
    if (!f.size) return null;
    const arr = [...f.values()];
    return arr[Math.floor(Math.random() * arr.length)].content;
  } catch { return null; }
}

// Track bot-generated quote message IDs so replies to them don't re-trigger
const quoteMsgIds = new Set<string>();
const quoteStates = new Map<string, QuoteState>();

export async function handleQuoteMention(message: Message, client: Client): Promise<void> {
  if (!message.mentions.has(client.user!.id)) return;
  if (!message.reference?.messageId) return;

  try {
    const repliedTo = await message.channel.messages.fetch(message.reference.messageId);
    if (repliedTo.author.id === client.user!.id) return;

    if (repliedTo.author.bot) {
      // Replace the repliedTo.author.bot check with this:
  if (repliedTo.author.bot) {
  // If it's a markov message, quote it directly
  if (markovMsgIds.has(repliedTo.id) && repliedTo.content?.length >= 2) {
    const state: QuoteState = {
      authorId:     client.user!.id,
      authorName:   message.guild?.members.me?.displayName ?? client.user!.username,
      authorHandle: client.user!.username,
      authorAvatar: client.user!.displayAvatarURL({ extension: 'png', size: 4096 }),
      content:      repliedTo.content,
      grayscale:    false,
      vertical:     false,
      bold:         false,
      guildId:      message.guild?.id ?? '',
      channelId:    message.channelId,
    };

    const buffer = await generateQuoteImage(state);
    const sent = await message.reply({
      files: [new AttachmentBuilder(buffer, { name: 'quote.png' })],
      components: [buildButtons(state)],
    });

    quoteMsgIds.add(sent.id);
    quoteStates.set(sent.id, state);
    setupButtonCollector(sent, state, message);
    return;
  }

  // Any other bot message (quote image, command reply etc.) — do nothing
  return;
}}


    if (!repliedTo.content || repliedTo.content.length < 2) {
      await message.reply({ content: '❌ That message has no text.' });
      return;
    }

    const member = message.guild
      ? await message.guild.members.fetch(repliedTo.author.id).catch(() => null)
      : null;

    const state: QuoteState = {
      authorId:     repliedTo.author.id,
      authorName:   member?.displayName ?? repliedTo.author.displayName,
      authorHandle: repliedTo.author.username,
      authorAvatar: member?.displayAvatarURL({ extension: 'png', size: 4096 })
                    ?? repliedTo.author.displayAvatarURL({ extension: 'png', size: 4096 }),
      content:   repliedTo.content,
      grayscale: false,
      vertical:  false,
      bold:      false,
      guildId:   message.guild?.id ?? '',
      channelId: message.channelId,
    };

    const buffer = await generateQuoteImage(state);
    const sent = await message.reply({
      files: [new AttachmentBuilder(buffer, { name: 'quote.png' })],
      components: [buildButtons(state)],
    });

    quoteMsgIds.add(sent.id);
    quoteStates.set(sent.id, state);
    setupButtonCollector(sent, state, message);
  } catch (err: unknown) {
    console.error('[quote]', err instanceof Error ? err.message : String(err));
  }
}

function setupButtonCollector(quoteMsg: Message, initial: QuoteState, source: Message) {
  const collector = quoteMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30 * 60 * 1000,
  });

  collector.on('collect', async (interaction: ButtonInteraction) => {
    if (interaction.user.id !== source.author.id) {
      await interaction.reply({
        content: '❌ Only the person who requested this quote can use these buttons.',
        ephemeral: true,
      });
      return;
    }

    const state = quoteStates.get(quoteMsg.id) ?? initial;
    const next = { ...state };

    switch (interaction.customId) {
      case 'quote_grayscale':   next.grayscale = !state.grayscale; break;
      case 'quote_orientation': next.vertical  = !state.vertical;  break;
      case 'quote_bold':        next.bold      = !state.bold;       break;
      case 'quote_regen':       break;
      case 'quote_new': {
        const nc = await fetchRandomUserMessage(source, state.authorId);
        if (!nc) {
          await interaction.reply({ content: '❌ No other messages found.', ephemeral: true });
          return;
        }
        next.content = nc;
        break;
      }
      default: return;
    }

    quoteStates.set(quoteMsg.id, next);
    try {
      const buf = await generateQuoteImage(next);
      await interaction.update({
        files: [new AttachmentBuilder(buf, { name: 'quote.png' })],
        components: [buildButtons(next)],
      } as any);
    } catch (err: unknown) {
      await interaction.reply({
        content: `❌ ${err instanceof Error ? err.message : String(err)}`,
        ephemeral: true,
      });
    }
  });

  collector.on('end', async () => {
    quoteStates.delete(quoteMsg.id);
    quoteMsgIds.delete(quoteMsg.id);
    try {
      const disabled = new ActionRowBuilder<ButtonBuilder>().addComponents(
        buildButtons(initial).components.map(b => ButtonBuilder.from(b as any).setDisabled(true)),
      );
      await quoteMsg.edit({ components: [disabled] });
    } catch {}
  });
}

export async function generateQuoteImage(state: QuoteState): Promise<Buffer> {
  const W = state.vertical ? 630 : 1200;
  const H = state.vertical ? 1200 : 630;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.clip();

  if (state.vertical) {
    await drawVertical(ctx, state);
  } else {
    await drawHorizontal(ctx, state);
  }

  if (!state.vertical) {
    roundRect(ctx, 0, 0, W, H, RADIUS);
    ctx.clip();
  }

  return canvas.toBuffer('image/png');
}