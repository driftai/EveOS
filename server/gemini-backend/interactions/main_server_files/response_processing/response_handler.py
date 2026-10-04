import json
import asyncio
import websockets
import time
from ..chat_history.chat_history_handler import save_chat_history
from ..transcription.transcription_normalizer import normalize_transcript
from ..websocket_server.session_handler.nexus_workspace_bridge import (
    publish_audio as publish_nexus_audio,
    publish_text as publish_nexus_text,
    publish_transcription as publish_nexus_transcription,
    publish_turn_complete as publish_nexus_turn_complete,
)

# Maximum audio buffer size (5MB)
MAX_AUDIO_BUFFER_SIZE = 1024 * 1024 * 5

class GeminiResponseHandler:
    def __init__(self, connection_monitor, audio_processor, inline_transcription_mode=False, session_role="interactive", connection_id=None):
        self.connection_monitor = connection_monitor
        self.audio_processor = audio_processor
        self.inline_transcription_mode = inline_transcription_mode
        self.session_role = session_role
        self.connection_id = connection_id
        self.last_audio_time = None
        self.audio_completion_threshold = 15.0  # Increased to 15.0s to allow for longer model thinking pauses without premature turn completion
        self.screen_suppressed_parts = 0

    def _screen_response_suppressed(self):
        if not getattr(self.connection_monitor, "screen_share_silent_response_pending", False):
            return False
        # NEVER suppress a turn that is already streaming to the client. The silent flag exists to
        # swallow a SPONTANEOUS acknowledgment turn after a silent context injection — but Mode 2
        # injections and data-stream deltas can arm it while a real reply is mid-stream, and
        # suppressing from that point dropped audio chunks out of the MIDDLE of the reply (the
        # "corrupted audio" symptom: gaps/garble where suppressed parts went missing).
        if len(getattr(self.audio_processor, "audio_data", b"") or b"") > 0:
            return False
        started_at = float(getattr(self.connection_monitor, "screen_share_silent_response_started_at", 0) or 0)
        if started_at and time.time() - started_at > 20:
            self._clear_screen_response_suppression()
            return False
        return True

    def _clear_screen_response_suppression(self):
        setattr(self.connection_monitor, "screen_share_silent_response_pending", False)
        setattr(self.connection_monitor, "screen_share_silent_response_started_at", 0)
        self.screen_suppressed_parts = 0

    async def process_response_part(self, part):
        """Process a single part of the Gemini response."""
        if not self.connection_monitor.is_websocket_open():
            print("Connection closed during part processing")
            return

        try:
            if self._screen_response_suppressed():
                self.screen_suppressed_parts += 1
                if hasattr(part, 'inline_data') and part.inline_data is not None:
                    self.last_audio_time = time.time()
                if hasattr(part, 'text') and part.text is not None:
                    preview = str(part.text).replace("\n", " ")[:80]
                    print(f"Suppressed silent screen-share response text: {preview}...")
                self.connection_monitor.record_activity()
                return

            if hasattr(part, 'text') and part.text is not None:
                await self.process_text_response(part.text)
                # Save text responses to chat history immediately
                if self.session_role != "world_book_narration":
                    save_chat_history(part.text, is_user=False)
            elif hasattr(part, 'inline_data') and part.inline_data is not None:
                self.last_audio_time = time.time()  # Track when audio was received
                await self.process_audio_response(part.inline_data.data)
            # After processing any part, record activity
            self.connection_monitor.record_activity()
        except Exception as e:
            print(f"Error processing response part: {e}")

    async def process_text_response(self, text):
        """Process text response from Gemini."""
        try:
            if self.session_role == "interactive" and self.connection_id is not None:
                await publish_nexus_text(self.connection_id, text)
            if self.connection_monitor.is_websocket_open():
                await self.connection_monitor.safe_send(json.dumps({
                    "text": text
                }))
                # Removed artificial sleep to prevent delivery latency
        except Exception as e:
            print(f"Error sending text response: {e}")

    async def process_transcription_response(self, text):
        """Publish one completed native Live output transcript."""
        if self._screen_response_suppressed():
            return None
        normalized = normalize_transcript(str(text or "").strip())
        if not normalized:
            return None
        try:
            if self.session_role == "interactive" and self.connection_id is not None:
                await publish_nexus_transcription(self.connection_id, normalized)
            if self.connection_monitor.is_websocket_open():
                await self.connection_monitor.safe_send(json.dumps({
                    "text": normalized,
                    "type": "transcription",
                    "is_transcription": True,
                    "source": "gemini_live_output_transcription",
                    "sessionRole": self.session_role,
                }))
                if self.session_role != "world_book_narration":
                    save_chat_history(normalized, is_user=False)
                return normalized
        except Exception as e:
            print(f"Error sending native output transcription: {e}")
        return None

    async def process_audio_response(self, audio_data):
        """Process audio response from Gemini."""
        try:
            print(f"Received audio data: {len(audio_data)} bytes")
            if not self.connection_monitor.is_websocket_open():
                print("Connection closed, skipping audio processing")
                return

            if self.session_role == "interactive" and self.connection_id is not None:
                await publish_nexus_audio(self.connection_id, audio_data)

            # Check if adding this chunk would exceed the buffer size
            if len(self.audio_processor.audio_data) + len(audio_data) > MAX_AUDIO_BUFFER_SIZE:
                print(f"Audio buffer would exceed size limit ({MAX_AUDIO_BUFFER_SIZE} bytes), resetting...")
                self.audio_processor.reset()
            
            # Process the audio data with minimal delay
            await self.audio_processor.process_audio_data(audio_data, self.audio_processor.is_sequential)
            
            # Removed artificial sleep to prevent audio buffer under-runs
        except Exception as e:
            print(f"Error processing audio data: {e}")
            # Reset audio processor on error
            self.audio_processor.reset()

    async def handle_turn_complete(self):
        """Handle turn completion from Gemini."""
        try:
            if self._screen_response_suppressed():
                print(f"Silent screen-share turn complete; suppressed {self.screen_suppressed_parts} response parts.")
                return None

            print(f"Processing turn complete with {len(self.audio_processor.audio_data)} bytes of audio data")
            # Process audio data and get transcription (passing inline mode flag)
            skip_transcription = self.session_role == "world_book_narration"
            transcribed_text = await self.audio_processor.process_turn_complete(
                self.inline_transcription_mode,
                skip_transcription=skip_transcription,
            )
            
            if transcribed_text:
                print(f"Got transcription: {transcribed_text[:50]}...")
                # Save to chat history
                if not skip_transcription:
                    save_chat_history(transcribed_text, is_user=False)

            if skip_transcription and self.connection_monitor.is_websocket_open():
                await self.connection_monitor.safe_send(json.dumps({
                    "type": "turn_complete",
                    "sessionRole": self.session_role,
                }))
                
            # Removed artificial sleep to prevent turn handoff latency
            return transcribed_text
        except Exception as e:
            print(f"Error processing transcription: {e}")
            return None
        finally:
            if self.session_role == "interactive" and self.connection_id is not None:
                await publish_nexus_turn_complete(self.connection_id)
            # Always reset audio processor after turn complete
            self.audio_processor.reset()
            self._clear_screen_response_suppression()

    async def check_audio_completion(self):
        """Check if audio processing should be completed based on timing."""
        if self.last_audio_time is not None:
            silence_duration = time.time() - self.last_audio_time
            if silence_duration > self.audio_completion_threshold:
                if hasattr(self.audio_processor, 'audio_data') and len(self.audio_processor.audio_data) > 0:
                    print(f"Auto-completing turn due to audio silence ({silence_duration:.1f}s)")
                    await self.handle_turn_complete()
                    return True
        return False
