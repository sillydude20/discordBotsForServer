// src/features/quote.ts
// ─────────────────────────────────────────────────────────────
// Triggered externally (from index.ts) when a user replies to
// a message with just @bot.
//
// Exports:
//   handleQuoteRequest(message, targetMessage, client)
//     — generate a quote image of `targetMessage`
//   generateQuoteImage(state)
//     — pure image generation, used by button collector
// ─────────────────────────────────────────────────────────────

import {
  Client, Message, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ButtonInteraction, ComponentType, AttachmentBuilder,
} from 'discord.js';
import { createCanvas, loadImage, SKRSContext2D, Image } from '@napi-rs/canvas';

export interface QuoteState {
  authorId: string; authorName: string; authorAvatar: string;
  authorHandle: string; content: string;
  grayscale: boolean; vertical: boolean; bold: boolean;
  guildId: string; channelId: string;
}

// Set of message IDs sent by the bot as quote images.
// index.ts checks this to decide whether a bot-reply should re-quote or markov.
export const quoteMsgIds = new Set<string>();

const quoteStates = new Map<string, QuoteState>();
const RADIUS = 16;

// ── Emoji image cache ─────────────────────────────────────────

const emojiCache = new Map<string, Image | null>();

async function loadEmojiImage(emoji: string): Promise<Image | null> {
  if (emojiCache.has(emoji)) return emojiCache.get(emoji)!;
  try {
    const codePoint = [...emoji]
      .map(c => c.codePointAt(0)!.toString(16).padStart(4, '0'))
      .filter(c => c !== 'fe0f')
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

// ── Text run splitting ────────────────────────────────────────

const EMOJI_REGEX = /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/gu;

interface TextRun { type: 'text' | 'emoji'; value: string; }

function splitIntoRuns(text: string): TextRun[] {
  const runs: TextRun[] = [];
  let last = 0;
  for (const match of text.matchAll(EMOJI_REGEX)) {
    if (match.index! > last) runs.push({ type: 'text', value: text.slice(last, match.index) });
    runs.push({ type: 'emoji', value: match[0] });
    last = match.index! + match[0].length;
  }
  if (last < text.length) runs.push({ type: 'text', value: text.slice(last) });
  return runs;
}

function measureLine(ctx: SKRSContext2D, text: string, fontSize: number): number {
  let width = 0;
  for (const run of splitIntoRuns(text)) {
    width += run.type === 'text' ? ctx.measureText(run.value).width : fontSize * 1.1;
  }
  return width;
}

async function drawLineWithEmoji(
  ctx: SKRSContext2D, line: string, x: number, y: number,
  fontSize: number, color: string, fontStyle: string,
) {
  const emojiSize = fontSize * 0.9;
  let cursorX = x;
  ctx.fillStyle = color;
  for (const run of splitIntoRuns(line)) {
    if (run.type === 'text') {
      ctx.font = fontStyle;
      ctx.fillText(run.value, cursorX, y);
      cursorX += ctx.measureText(run.value).width;
    } else {
      const img = await loadEmojiImage(run.value);
      if (img) {
        ctx.drawImage(img, cursorX, y - emojiSize * 0.05, emojiSize, emojiSize);
        cursorX += emojiSize;
      } else {
        cursorX += fontSize * 0.8;
      }
    }
  }
}

// ── Content cleaning ──────────────────────────────────────────

function cleanContent(content: string): string {
  return content
    .replace(/<a:([^:]+):\d+>/g, '[$1]')
    .replace(/<:([^:]+):\d+>/g, '[$1]')
    .replace(/<@!?\d+>/g, '@user')
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .trim();
}

// ── Text wrapping ─────────────────────────────────────────────

function wrapText(ctx: SKRSContext2D, text: string, maxW: number, fontSize: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (measureLine(ctx, word, fontSize) > maxW) {
      if (line) { lines.push(line); line = ''; }
      let partial = '';
      for (const char of word) {
        if (measureLine(ctx, partial + char, fontSize) > maxW) { lines.push(partial); partial = char; }
        else partial += char;
      }
      if (partial) line = partial;
      continue;
    }
    const test = line ? `${line} ${word}` : word;
    if (measureLine(ctx, test, fontSize) > maxW && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.quadraticCurveTo(x+w,y,x+w,y+r);
  ctx.lineTo(x+w,y+h-r); ctx.quadraticCurveTo(x+w,y+h,x+w-r,y+h); ctx.lineTo(x+r,y+h);
  ctx.quadraticCurveTo(x,y+h,x,y+h-r); ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y);
  ctx.closePath();
}

function applyGrayscale(ctx: SKRSContext2D, x: number, y: number, w: number, h: number) {
  const d = ctx.getImageData(x, y, w, h); const data = d.data;
  for (let i = 0; i < data.length; i += 4) {
    const avg = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    data[i] = data[i+1] = data[i+2] = avg;
  }
  ctx.putImageData(d, x, y);
}

// ── Canvas drawing ────────────────────────────────────────────

async function drawHorizontal(ctx: SKRSContext2D, state: QuoteState) {
  const W = 1200, H = 630, AW = 560, FW = 220;
  const TEXT_X = 670, TEXT_W = W - TEXT_X - 60, PAD_V = 50;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  try {
    const img = await loadImage(state.authorAvatar + '?size=4096');
    const scale = Math.max(AW / img.width, H / img.height);
    ctx.drawImage(img, (AW - img.width*scale)/2, (H - img.height*scale)/2, img.width*scale, img.height*scale);
    if (state.grayscale) applyGrayscale(ctx, 0, 0, AW, H);
  } catch {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, AW, H);
  }

  const fg = ctx.createLinearGradient(AW - FW, 0, AW + 40, 0);
  fg.addColorStop(0, '#0a0a0a00'); fg.addColorStop(1, '#0a0a0aff');
  ctx.fillStyle = fg; ctx.fillRect(AW - FW, 0, FW + 40, H);

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const displayContent = cleanContent(state.content);

  let fs = 80, lines: string[] = [], lh = fs * 1.3;
  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3; lines = wrapText(ctx, displayContent, TEXT_W, fs);
    if (lines.length * lh + 100 <= H - PAD_V * 2) break;
    fs--;
  }

  const totalTextH = lines.length * lh;
  const startY = (H - (totalTextH + 100)) / 2;
  const fontStyle = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
  for (let i = 0; i < lines.length; i++) {
    await drawLineWithEmoji(ctx, lines[i], TEXT_X, startY + i * lh, fs, '#ffffff', fontStyle);
  }

  const authorY = startY + totalTextH + 20;
  const nfs = Math.max(32, Math.floor(fs * 0.42));
  const hfs = Math.max(24, Math.floor(fs * 0.32));
  ctx.font = `italic 600 ${nfs}px sans-serif`; ctx.fillStyle = '#cccccc';
  ctx.fillText(`- ${state.authorName}`, TEXT_X, authorY);
  ctx.font = `400 ${hfs}px sans-serif`; ctx.fillStyle = '#777777';
  ctx.fillText(`@${state.authorHandle}`, TEXT_X, authorY + nfs + 6);

  ctx.font = '400 13px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('if you see this your mom gay lol', W - 18, H - 16);
}

async function drawVertical(ctx: SKRSContext2D, state: QuoteState) {
  const W = 630, H = 1200, AH = 560, FH = 280;
  const TEXT_Y = 700, TEXT_H = H - TEXT_Y - 60, TEXT_X = 60, TEXT_W = W - TEXT_X * 2;

  ctx.fillStyle = '#0a0a0a'; ctx.fillRect(0, 0, W, H);

  try {
    const img = await loadImage(state.authorAvatar + '?size=4096');
    const scale = Math.max(W / img.width, AH / img.height);
    ctx.drawImage(img, (W - img.width*scale)/2, (AH - img.height*scale)/2, img.width*scale, img.height*scale);
    if (state.grayscale) applyGrayscale(ctx, 0, 0, W, AH);
  } catch {
    ctx.fillStyle = '#222'; ctx.fillRect(0, 0, W, AH);
  }

  const fg = ctx.createLinearGradient(0, AH - FH, 0, AH + 40);
  fg.addColorStop(0, '#0a0a0a00'); fg.addColorStop(1, '#0a0a0aff');
  ctx.fillStyle = fg; ctx.fillRect(0, AH - FH, W, FH + 40);

  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const displayContent = cleanContent(state.content);

  let fs = 80, lines: string[] = [], lh = fs * 1.3;
  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3; lines = wrapText(ctx, displayContent, TEXT_W, fs);
    if (lines.length * lh + 100 <= TEXT_H) break;
    fs--;
  }

  const totalTextH = lines.length * lh;
  const startY = TEXT_Y + (TEXT_H - (totalTextH + 100)) / 2;
  const fontStyle = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
  for (let i = 0; i < lines.length; i++) {
    await drawLineWithEmoji(ctx, lines[i], TEXT_X, startY + i * lh, fs, '#ffffff', fontStyle);
  }

  const authorY = startY + totalTextH + 20;
  const nfs = Math.max(32, Math.floor(fs * 0.42));
  const hfs = Math.max(24, Math.floor(fs * 0.32));
  ctx.font = `italic 600 ${nfs}px sans-serif`; ctx.fillStyle = '#cccccc';
  ctx.fillText(`- ${state.authorName}`, TEXT_X, authorY);
  ctx.font = `400 ${hfs}px sans-serif`; ctx.fillStyle = '#777777';
  ctx.fillText(`@${state.authorHandle}`, TEXT_X, authorY + nfs + 6);

  ctx.font = '400 13px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.15)';
  ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
  ctx.fillText('Quote', W - 18, H - 16);
}

// ── Buttons ───────────────────────────────────────────────────

function buildButtons(state: QuoteState): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('quote_grayscale')
      .setLabel(state.grayscale ? '🎨 Color' : '⬛ B&W')
      .setStyle(state.grayscale ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_orientation')
      .setLabel(state.vertical ? '↔️ Horizontal' : '↕️ Vertical')
      .setStyle(ButtonStyle.Secondary),
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
      m.author.id === userId && m.id !== source.id &&
      m.content.length > 10 && !m.content.startsWith('/'),
    );
    if (!f.size) return null;
    const arr = [...f.values()];
    return arr[Math.floor(Math.random() * arr.length)].content;
  } catch { return null; }
}

function setupButtonCollector(quoteMsg: Message, initial: QuoteState, requester: Message) {
  const collector = quoteMsg.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30 * 60 * 1000,
  });

  collector.on('collect', async (interaction: ButtonInteraction) => {
    if (interaction.user.id !== requester.author.id) {
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
        const nc = await fetchRandomUserMessage(requester, state.authorId);
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

// ── Public API ────────────────────────────────────────────────

/**
 * Generate and send a quote image of `target` as a reply to `requester`.
 * Call this from index.ts after you've already confirmed the target is quotable.
 */
export async function handleQuoteRequest(
  requester: Message,
  target: Message,
  client: Client,
): Promise<void> {
  if (!target.content || target.content.length < 2) {
    await requester.reply({ content: '❌ That message has no text to quote.' });
    return;
  }

  const member = requester.guild
    ? await requester.guild.members.fetch(target.author.id).catch(() => null)
    : null;

  const state: QuoteState = {
    authorId:     target.author.id,
    authorName:   member?.displayName ?? target.author.displayName,
    authorHandle: target.author.username,
    authorAvatar: member?.displayAvatarURL({ extension: 'png', size: 4096 })
                  ?? target.author.displayAvatarURL({ extension: 'png', size: 4096 }),
    content:   target.content,
    grayscale: false,
    vertical:  false,
    bold:      false,
    guildId:   requester.guild?.id ?? '',
    channelId: requester.channelId,
  };

  try {
    const buffer = await generateQuoteImage(state);
    const sent = await requester.reply({
      files: [new AttachmentBuilder(buffer, { name: 'quote.png' })],
      components: [buildButtons(state)],
    });

    quoteMsgIds.add(sent.id);
    quoteStates.set(sent.id, state);
    setupButtonCollector(sent, state, requester);
  } catch (err: unknown) {
    console.error('[quote]', err instanceof Error ? err.message : String(err));
  }
}

export async function generateQuoteImage(state: QuoteState): Promise<Buffer> {
  const W = state.vertical ? 630 : 1200;
  const H = state.vertical ? 1200 : 630;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  roundRect(ctx, 0, 0, W, H, RADIUS);
  ctx.clip();

  if (state.vertical) await drawVertical(ctx, state);
  else await drawHorizontal(ctx, state);

  if (!state.vertical) { roundRect(ctx, 0, 0, W, H, RADIUS); ctx.clip(); }

  return canvas.toBuffer('image/png');
}