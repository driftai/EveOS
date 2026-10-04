import asyncio
import json
import websockets
from .stream_error_logic import StreamErrorHandler
from ..response_parser import _receive_responses
from ...response_handler import GeminiResponseHandler
from ....api_configuration.gemini_config import TimeoutConfig, usage_monitor
from ....status_monitoring.api_usage_monitor import api_usage_tracker

class StreamSession:
    """
    Manages the lifecycle of the Gemini response stream.
    """
    def __init__(self, session, websocket, connection_monitor, connection_id, audio_processor, response_timeout=None, inline_transcription_mode=False, session_role="interactive"):
        self.session = session
        self.websocket = websocket
        self.connection_monitor = connection_monitor
        self.connection_id = connection_id
        self.audio_processor = audio_processor
        self.response_timeout = response_timeout
        self.inline_transcription_mode = inline_transcription_mode
        self.session_role = session_role
        
        self.error_handler = StreamErrorHandler(connection_id)
        self.response_handler = GeminiResponseHandler(
            connection_monitor,
            audio_processor,
            inline_transcription_mode=inline_transcription_mode,
            session_role=session_role,
            connection_id=connection_id,
        )
        self.retry_attempt = 0

    async def run(self):
        """
        Execute the main response receiving loop.
        """
        # Track this request in the API usage monitor
        request_index = api_usage_tracker.log_request_start(str(self.connection_id), "chat_response")
        request_start_time = asyncio.get_event_loop().time()
        
        receive_task = None
        
        try:
            print(f"Starting persistent response handler for connection {self.connection_id}")
            
            while True:
                if not self.connection_monitor.is_websocket_open():
                    print(f"Connection {self.connection_id} closed, stopping response handler")
                    break

                try:
                    # Use configurable timeout based on retry attempt
                    base_timeout = self.response_timeout if self.response_timeout is not None else TimeoutConfig.RESPONSE_TIMEOUT
                    current_timeout = base_timeout if self.response_timeout is not None else TimeoutConfig.get_response_timeout(self.retry_attempt)

                    print(f"Waiting for Gemini response watchdog (timeout: {current_timeout}s, attempt {self.retry_attempt + 1})...")
                    usage_monitor.increment_request()

                    # Start the response receiving task
                    receive_task = asyncio.create_task(_receive_responses(self.session, self.response_handler, self.connection_monitor, self.connection_id))

                    while not receive_task.done():
                        try:
                            # Wait for next packet OR timeout
                            # Since _receive_responses is a continuous stream, we use wait_for on the task itself
                            # BUT we want to reset the timeout if it's still running.
                            # Actually, a better way is to have _receive_responses notify us of activity, 
                            # or just recognize that it's a long-running task.
                            # Let's use a simpler watchdog approach:
                            await asyncio.wait_for(asyncio.shield(receive_task), timeout=current_timeout)
                            # If we get here, receive_task completed successfully (turn finished)
                            break 
                        except asyncio.TimeoutError:
                            # If we timed out, check if any audio was received recently
                            import time
                            last_activity = getattr(self.response_handler, 'last_audio_time', 0)
                            silence_duration = time.time() - last_activity if last_activity else 999
                            
                            if silence_duration < (current_timeout * 0.8):
                                # We are still getting audio, just not the end of the turn.
                                # Continue waiting - reset the watchdog.
                                print(f"Watchdog reset for connection {self.connection_id} (active audio streaming)")
                                continue
                            else:
                                # True silence/timeout
                                print(f"Watchdog timeout for connection {self.connection_id} (silence: {silence_duration:.1f}s)")
                                receive_task.cancel()
                                await asyncio.gather(receive_task, return_exceptions=True)
                                await self._handle_idle_timeout(current_timeout)
                                break

                    if receive_task.done() and not receive_task.cancelled():
                        # Check result of receive task
                        try:
                            result = await receive_task
                            if result == "rotate":
                                print(f"Gemini requested planned session rotation for connection {self.connection_id}")
                                break
                            await self._handle_success()
                            continue
                        except websockets.exceptions.ConnectionClosedOK:
                            print(f"Connection {self.connection_id} closed normally")
                            break
                        except websockets.exceptions.ConnectionClosed as e:
                            # Handle connection closures (deadlines etc)
                            should_break = await self._handle_connection_closed(e)
                            if should_break:
                                break
                        except asyncio.CancelledError:
                            print(f"Response receiving task cancelled")
                            break
                        except Exception as e:
                            # Handle other errors
                            should_break = await self._handle_generic_error(e)
                            if should_break:
                                break
                            
                except Exception as e:
                    should_break = await self._handle_outer_loop_error(e)
                    if should_break:
                        break
                        
        except Exception as e:
            print(f"Critical error in receive_from_gemini: {e}")
            if self.connection_monitor.is_websocket_open():
                await self.connection_monitor.safe_send(json.dumps({
                    "text": f"Critical connection error: {str(e)}",
                    "is_system_message": True,
                    "is_error": True
                }))
        finally:
            await self._cleanup(request_index, request_start_time, receive_task)

    async def _handle_idle_timeout(self, current_timeout):
        # Check if we have accumulated audio data that needs processing
        if hasattr(self.audio_processor, 'audio_data') and len(self.audio_processor.audio_data) > 0:
            print(f"Processing accumulated audio data on keepalive: {len(self.audio_processor.audio_data)} bytes")
            try:
                await self.response_handler.handle_turn_complete()
            except Exception as e:
                print(f"Error processing accumulated audio on keepalive: {e}")
        
        self.error_handler.reset()

    async def _handle_success(self):
        print(f"Response receiving completed normally for connection {self.connection_id}")
        self.error_handler.reset()
        self.retry_attempt = 0
        print(f"Turn completed successfully, continuing session for connection {self.connection_id}")

    async def _handle_connection_closed(self, e):
        print(f"Connection {self.connection_id} closed: {e}")
        if getattr(self.connection_monitor, "planned_session_rotation", False):
            return True
        if await self._prepare_resumable_rotation(e):
            return True
        error_msg = str(e)
        is_deadline = "deadline expired before operation could complete" in error_msg.lower() or e.code == 1011
        api_usage_tracker.log_error(
            str(self.connection_id),
            "deadline_error" if is_deadline else "connection_closed",
            error_msg,
            is_deadline_error=is_deadline,
        )
        if is_deadline:
            self.error_handler.deadline_consecutive_errors += 1
        self.error_handler.consecutive_errors += 1
        await self._notify_stop(
            "Gemini Live transport timed out. EveOS will rebuild the complete session."
            if is_deadline else
            "Gemini Live transport closed. EveOS will rebuild the complete session."
        )
        return True

    async def _handle_generic_error(self, e):
        if await self._prepare_resumable_rotation(e):
            return True
        self.error_handler.consecutive_errors += 1
        api_usage_tracker.log_error(
            str(self.connection_id), "response_error", str(e), is_deadline_error=False
        )
        await self._notify_stop(
            f"Gemini Live session ended ({str(e)[:160]}). EveOS will rebuild the complete session."
        )
        return True

    async def _prepare_resumable_rotation(self, error):
        handle = str(getattr(self.connection_monitor, "session_resumption_handle", "") or "")
        message = str(error or "")
        code = getattr(error, "code", None) or getattr(getattr(error, "rcvd", None), "code", None)
        is_1008 = code == 1008 or "received 1008" in message.lower()
        blocked_markers = (
            "api key", "ip address restriction", "unauthorized", "permission denied",
            "quota", "resource exhausted", "invalid argument", "model not found",
            "not supported for bidigeneratecontent",
        )
        if not (handle and is_1008) or any(marker in message.lower() for marker in blocked_markers):
            return False
        setattr(self.connection_monitor, "planned_session_rotation", True)
        if self.connection_monitor.is_websocket_open():
            await self.connection_monitor.safe_send(json.dumps({
                "type": "session_go_away",
                "resumeAvailable": True,
                "reason": "Gemini closed an otherwise resumable Live session.",
            }))
        return True

    async def _handle_outer_loop_error(self, e):
        if await self._prepare_resumable_rotation(e):
            return True
        self.error_handler.consecutive_errors += 1
        print(f"Error in receive_from_gemini loop (consecutive: {self.error_handler.consecutive_errors}/{self.error_handler.max_consecutive_errors}): {e}")
        api_usage_tracker.log_error(str(self.connection_id), "connection_error", str(e), is_deadline_error=False)
        await self._notify_stop(
            f"Gemini Live receive loop ended ({str(e)[:160]}). EveOS will rebuild the complete session."
        )
        return True

    async def _notify_stop(self, message):
        if self.connection_monitor.is_websocket_open():
            await self.connection_monitor.safe_send(json.dumps({
                "text": message,
                "type": "session_reconnect_required",
                "retryable": True,
                "is_system_message": True,
                "is_error": True
            }))

    async def _cleanup(self, request_index, request_start_time, receive_task):
        # Log final usage statistics
        stats = usage_monitor.get_stats()
        print(f"\nConnection {self.connection_id} usage statistics:")
        print(f"  Requests: {stats['requests']}")
        print(f"  Errors: {stats['errors']} (rate: {stats['error_rate']:.2%})")
        print(f"  Deadline errors: {stats['deadline_errors']} (rate: {stats['deadline_error_rate']:.2%})")
        
        # Track request completion in API usage monitor
        if request_start_time:
            response_time = asyncio.get_event_loop().time() - request_start_time
            success = self.error_handler.consecutive_errors == 0 and self.error_handler.deadline_consecutive_errors == 0
            api_usage_tracker.log_request_completion(request_index, success, response_time)
        
        # Cancel any remaining tasks
        if receive_task and not receive_task.done():
            receive_task.cancel()
        if receive_task:
            await asyncio.gather(receive_task, return_exceptions=True)
        
        print(f"Persistent response handler for connection {self.connection_id} terminated")
