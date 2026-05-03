import os
import io
import asyncio
import discord
from faster_whisper import WhisperModel
from dotenv import load_dotenv

load_dotenv()

model = WhisperModel("small", device="cpu", compute_type="int8")
print("[whisper] Model loaded")

def is_voice_message(message: discord.Message) -> bool:
    if len(message.attachments) != 1:
        return False
    att = message.attachments[0]
    return att.filename == "voice-message.ogg" or (att.content_type or "").startswith("audio/ogg")

def transcribe_audio(audio_bytes: bytes) -> str:
    audio_file = io.BytesIO(audio_bytes)
    segments, info = model.transcribe(audio_file, beam_size=5)
    print(f"[voiceTranscribe] Detected language: {info.language} ({info.language_probability:.0%} confidence)")
    return " ".join(segment.text for segment in segments).strip()

class BotClient(discord.Client):
    async def on_ready(self):
        print(f"Logged in as {self.user}")

    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return
        if not is_voice_message(message):
            return

        att = message.attachments[0]
        print(f"[voiceTranscribe] Voice message from {message.author.name}")

        try:
            audio_bytes = await att.read()
            print(f"[voiceTranscribe] Downloaded {len(audio_bytes)} bytes")

            # Run blocking inference in a thread so the event loop stays alive
            loop = asyncio.get_event_loop()
            transcript = await loop.run_in_executor(None, transcribe_audio, audio_bytes)
            print(f"[voiceTranscribe] Transcript: {transcript}")

            if not transcript:
                await message.reply("🎙️ I couldn't make out anything in that voice message.")
                return

            await message.reply(f" {transcript}")

        except Exception as e:
            print(f"[voiceTranscribe] Error: {e}")
            await message.reply("❌ Failed to transcribe the voice message.")

intents = discord.Intents.default()
intents.message_content = True

client = BotClient(intents=intents)
client.run(os.environ["BOT_TOKEN"])