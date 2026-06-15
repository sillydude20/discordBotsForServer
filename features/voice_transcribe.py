import io
import asyncio
import requests
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

app = Flask(__name__)
print("[whisper] Loading model...")
model = WhisperModel("small", device="cpu", compute_type="int8")
print("[whisper] Model loaded")

@app.route("/transcribe", methods=["POST"])
def transcribe():
    audio_bytes = request.data
    audio_file = io.BytesIO(audio_bytes)
    segments, info = model.transcribe(audio_file, beam_size=5)
    transcript = " ".join(segment.text for segment in segments).strip()
    print(f"[whisper] {info.language} ({info.language_probability:.0%}): {transcript}")
    return jsonify({ "transcript": transcript, "language": info.language })

if __name__ == "__main__":
    app.run(port=5001)