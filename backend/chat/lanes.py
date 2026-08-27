"""Independent bounded worker lanes for Admin chat control operations."""

from chat.executor import BoundedThreadPoolExecutor

# A slow provider can never consume the worker needed to revoke its Team turn.
TURN = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=2, thread_name_prefix="shimpz-chat-turn")
STOP = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=4, thread_name_prefix="shimpz-chat-stop")
SYNC = BoundedThreadPoolExecutor(max_workers=2, max_outstanding=4, thread_name_prefix="shimpz-chat-sync")
