// src/features/quote.ts
import {
  Client, Message, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ButtonInteraction, ComponentType, AttachmentBuilder,
} from 'discord.js';
import { createCanvas, loadImage, SKRSContext2D } from '@napi-rs/canvas';

interface QuoteState {
  authorId: string; authorName: string; authorAvatar: string;
  authorHandle: string; content: string;
  grayscale: boolean; vertical: boolean; bold: boolean;
  guildId: string; channelId: string;
}

const BG = '#0f0f0f'; const TEXT = '#ffffff'; const SUB = '#aaaaaa'; const RADIUS = 16;

function wrapText(ctx: SKRSContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    // If a single word is wider than maxW, break it character by character
    if (ctx.measureText(word).width > maxW) {
      if (line) { lines.push(line); line = ''; }
      let partial = '';
      for (const char of word) {
        if (ctx.measureText(partial + char).width > maxW) {
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
    if (ctx.measureText(test).width > maxW && line) {
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
  const d = ctx.getImageData(x,y,w,h); const data = d.data;
  for (let i = 0; i < data.length; i += 4) {
    const avg = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    data[i] = data[i+1] = data[i+2] = avg;
  }
  ctx.putImageData(d, x, y);
}

async function drawHorizontal(ctx: SKRSContext2D, state: QuoteState) {
  const W = 1200, H = 630, AW = 560, FW = 220;
  const TEXT_X = 670;           // left edge of text, well past the fade
  const TEXT_W = W - TEXT_X - 60;  // = 470px available
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

  // LEFT-aligned text — never bleeds left or right
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let fs = 80;
  let lines: string[] = [];
  let lh = fs * 1.3;

  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3;
    lines = wrapText(ctx, state.content, TEXT_W);
    const totalH = lines.length * lh;
    if (totalH + 100 <= H - PAD_V * 2) break;
    fs -= 1;
  }

  ctx.fillStyle = '#ffffff';
  const totalTextH = lines.length * lh;
  const blockH = totalTextH + 100;
  const startY = (H - blockH) / 2;

  lines.forEach((line, i) => ctx.fillText(line, TEXT_X, startY + i * lh));

  // Author — left aligned under text
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
  const TEXT_H = H - TEXT_Y - 60;   // available vertical space for text
  const TEXT_X = 60;
  const TEXT_W = W - TEXT_X * 2;    // = 510px, padded both sides
  const PAD_V = 50;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, W, H);

  // Avatar — cover fit top portion
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

  // Fade avatar → black (downward)
  const fg = ctx.createLinearGradient(0, AH - FH, 0, AH + 40);
  fg.addColorStop(0, '#0a0a0a00');
  fg.addColorStop(1, '#0a0a0aff');
  ctx.fillStyle = fg;
  ctx.fillRect(0, AH - FH, W, FH + 40);

  // Left-aligned text, auto-shrink
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let fs = 80;
  let lines: string[] = [];
  let lh = fs * 1.3;

  while (fs >= 14) {
    ctx.font = `${state.bold ? '700' : '400'} ${fs}px sans-serif`;
    lh = fs * 1.3;
    lines = wrapText(ctx, state.content, TEXT_W);
    const totalH = lines.length * lh;
    if (totalH + 100 <= TEXT_H) break;
    fs -= 1;
  }

  ctx.fillStyle = '#ffffff';
  const totalTextH = lines.length * lh;
  const blockH = totalTextH + 100;
  const startY = TEXT_Y + (TEXT_H - blockH) / 2;

  lines.forEach((line, i) => ctx.fillText(line, TEXT_X, startY + i * lh));

  // Author
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
      .setLabel(state.grayscale?'🎨 Color':'⬛ B&W').setStyle(state.grayscale?ButtonStyle.Primary:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_orientation')
      .setLabel(state.vertical?'↔️ Horizontal':'↕️ Vertical').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_bold')
      .setLabel('B').setStyle(state.bold?ButtonStyle.Primary:ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_regen').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('quote_new').setLabel('New Quote').setStyle(ButtonStyle.Success),
  );
}

async function fetchRandomUserMessage(source: Message, userId: string): Promise<string|null> {
  try {
    const msgs=await source.channel.messages.fetch({limit:100});
    const f=msgs.filter(m=>m.author.id===userId&&m.id!==source.id&&m.content.length>10&&!m.content.startsWith('/'));
    if (!f.size) return null;
    const arr=[...f.values()]; return arr[Math.floor(Math.random()*arr.length)].content;
  } catch { return null; }
}

const quoteStates=new Map<string,QuoteState>();

export async function handleQuoteMention(message: Message, client: Client): Promise<void> {
  if (!message.mentions.has(client.user!.id)) return;
  if (!message.reference?.messageId) return;
  try {
    const quoted=await message.channel.messages.fetch(message.reference.messageId);
    if (!quoted.content||quoted.content.length<2) { await message.reply({content:'❌ That message has no text.'}); return; }
    const member=message.guild?await message.guild.members.fetch(quoted.author.id).catch(()=>null):null;
    const state: QuoteState = {
      authorId:quoted.author.id, authorName:member?.displayName??quoted.author.displayName,
      authorHandle:quoted.author.username, authorAvatar:quoted.author.displayAvatarURL({extension:'png',size:4096}),
      content:quoted.content, grayscale:false, vertical:false, bold:false,
      guildId:message.guild?.id??'', channelId:message.channelId,
    };
    const buffer=await generateQuoteImage(state);
    const sent=await message.reply({files:[new AttachmentBuilder(buffer,{name:'quote.png'})],components:[buildButtons(state)]});
    quoteStates.set(sent.id,state);
    setupButtonCollector(sent,state,message);
  } catch(err:unknown) { console.error('[quote]',err instanceof Error?err.message:String(err)); }
}

function setupButtonCollector(quoteMsg: Message, initial: QuoteState, source: Message) {
  const collector=quoteMsg.createMessageComponentCollector({componentType:ComponentType.Button,time:30*60*1000});
  collector.on('collect',async(interaction:ButtonInteraction)=>{
    if (interaction.user.id !== source.author.id) {
      await interaction.reply({ content: '❌ Only the person who requested this quote can use these buttons.', ephemeral: true });
      return;
    }
    const state=quoteStates.get(quoteMsg.id)??initial;
    const next={...state};
    switch(interaction.customId) {
      case 'quote_grayscale': next.grayscale=!state.grayscale; break;
      case 'quote_orientation': next.vertical=!state.vertical; break;
      case 'quote_bold': next.bold=!state.bold; break;
      case 'quote_regen': break;
      case 'quote_new': {
        const nc=await fetchRandomUserMessage(source,state.authorId);
        if (!nc) { await interaction.reply({content:"❌ No other messages found.",ephemeral:true}); return; }
        next.content=nc; break;
      }
      default: return;
    }
    quoteStates.set(quoteMsg.id,next);
    try {
      const buf=await generateQuoteImage(next);
      await interaction.update({files:[new AttachmentBuilder(buf,{name:'quote.png'})],components:[buildButtons(next)]} as any);
    } catch(err:unknown) { await interaction.reply({content:`❌ ${err instanceof Error?err.message:String(err)}`,ephemeral:true}); }
  });
  collector.on('end',async()=>{
    quoteStates.delete(quoteMsg.id);
    try {
      const disabled=new ActionRowBuilder<ButtonBuilder>().addComponents(
        buildButtons(initial).components.map(b=>ButtonBuilder.from(b as any).setDisabled(true)));
      await quoteMsg.edit({components:[disabled]});
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