// src/features/gifOverlay.ts
import { Message, AttachmentBuilder, TextChannel } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';

const OVERLAY_PATH = path.resolve('src/assets/overlay.gif');

export async function handleGifOverlay(message: Message): Promise<void> {
  if (!message.content.startsWith('!cum')) return;

  const mentionedUser = message.mentions.users.first();
  if (!mentionedUser) {
    await message.reply('You need to @mention a user!');
    return;
  }

  const tempAvatar = path.join(os.tmpdir(), `avatar_${mentionedUser.id}.png`);
  const tempOutput = path.join(os.tmpdir(), `output_${mentionedUser.id}.gif`);

  try {
    // 1. Download avatar to a temp file
    const member = await message.guild?.members.fetch(mentionedUser.id).catch(() => null);
    const avatarUrl =
      member?.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true }) ??
      mentionedUser.displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });

    const res = await fetch(avatarUrl);
    const avatarBuffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(tempAvatar, avatarBuffer);

    // 2. Use ffmpeg to overlay the gif on top of the avatar
    // The overlay gif is 448x272, we center it on the avatar (512x512)
    const x = Math.round((512 - 448) / 2); // = 32
    const y = Math.round((512 - 272) / 2); // = 120

    await new Promise<void>((resolve, reject) => {
  ffmpeg()
    .input(tempAvatar)
    .inputOptions(['-loop', '1'])          // loop the static avatar infinitely
    .input(OVERLAY_PATH)
    .complexFilter([
      '[0:v]scale=512:512[base]',
  '[1:v]scale=512:512[ov]',
  '[base][ov]overlay=0:0:shortest=1', // shortest=1 now refers to the GIF length
    ])
    .outputOptions([
      '-t', '10',          // max duration in seconds — set to however long your gif is
      '-loop', '0',        // loop the output gif forever
      '-gifflags', '+transdiff',
      '-y',
    ])
    .output(tempOutput)
    .on('end', () => resolve())
    .on('error', (err) => reject(err))
    .run();
});

    // 3. Send it
    const outputBuffer = fs.readFileSync(tempOutput);
    const attachment = new AttachmentBuilder(outputBuffer, { name: 'overlay.gif' });
    await (message.channel as TextChannel).send({
      content: `<@${mentionedUser.id}>`,
      files: [attachment],
    });

  } catch (err) {
    console.error('[gifOverlay] Full error:', err);
    if (err instanceof Error) {
      console.error('[gifOverlay] Message:', err.message);
      console.error('[gifOverlay] Stack:', err.stack);
    }
    await message.reply('Something went wrong generating the GIF, sorry!').catch(() => null);
  } finally {
    // Clean up temp files
    fs.rmSync(tempAvatar, { force: true });
    fs.rmSync(tempOutput, { force: true });
  }
}