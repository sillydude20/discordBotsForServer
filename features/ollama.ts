import { Message, TextChannel, GuildMember } from 'discord.js';
import { hasAdminRoleMember } from '../utils/rolecheck';
import { getRecentMessagesByUser } from '../utils/database'; // adjust path if needed

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const MODEL = 'gemma3:4b';
//const MODEL = 'gemma4:26b';
const SYSTEM_PROMPT = `You are Zinnia, the resident bot of a private Discord server called Fangdom. 
You roast people with clever, specific, cutting insults — not generic stuff like "you're ugly" or "you smell." 
Think more: weaponized specificity, calling out actual behavior, ironic observations. 
Swearing is fine. Keep it to 1-2 sentences. Never break character, never apologize.
MAKE SURE TO USE MESSAGE HISTORY OF THE USER`;

export async function handleOllamaReply(
  message: Message, userText: string, mentionPrefix?: string
): Promise<void> {
  try {
    const member = message.member as GuildMember;
    if (!member || !hasAdminRoleMember(member)) {
      await message.react('🔒');
      return;
    }

    // Parse @mention and grab message history
    const mentionMatch = userText.match(/^<@!?(\d+)>/);
    const targetId = mentionMatch?.[1];
    const guildId = message.guildId!;

    let contextBlock = '';
    if (targetId) {
      const messages = getRecentMessagesByUser(guildId, targetId);
      if (messages.length > 0) {
        const history = messages.map(m => `- ${m}`).join('\n');
        contextBlock = `\n\nHere are some of their recent messages in the server:\n${history}\n\nUse these to make the roast specific to them — reference how they actually talk, what they say, their topics, their vocabulary.`;
      }
    }

    const prompt = `${SYSTEM_PROMPT}\n\nSomeone in Fangdom just asked you to roast: ${userText}${contextBlock}\n\nReply with your roast:`;

    if (message.channel instanceof TextChannel) {
      await message.channel.sendTyping();
    }
    console.log('=== OLLAMA PROMPT ===');
console.log(prompt);
console.log('====================');

    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        stream: false,
        options: {
          num_gpu: 999,
          temperature: 0.9,
          num_predict: 150,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Ollama error: ${response.status}`);
      return;
    }

    const data = await response.json() as { response?: string };
    const reply = data.response?.trim();
    if (reply) {
      const content = mentionPrefix ? `${mentionPrefix} ${reply}` : reply;
      await message.reply(content);
    }
  } catch (err) {
    console.error('Ollama request failed:', err);
  }
}