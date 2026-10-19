"""The Space's chat gate (ADR-0119): at most the limit run at once, the rest wait in order and are told where."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from chat import gate as chat_gate


async def _limit(value: int = 2) -> int:
    return value


class ChatGateTests(unittest.TestCase):
    def test_operations_beyond_the_limit_wait_in_order_and_are_told_their_place(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            told: dict[str, list[int | None]] = {name: [] for name in "abcd"}
            order: list[str] = []
            release = {name: asyncio.Event() for name in "abcd"}

            async def operation(name: str) -> None:
                async with gate.slot(told[name].append, _limit):
                    order.append(name)
                    await release[name].wait()

            tasks = {name: asyncio.create_task(operation(name)) for name in "abcd"}
            for _ in range(4):
                await asyncio.sleep(0)
            # The limit is read once, with the first operation that needs it.
            self.assertEqual((order, gate.limit), (["a", "b"], 2))
            self.assertEqual((told["a"], told["b"], told["c"], told["d"]), ([None], [None], [1], [2]))
            release["a"].set()
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            self.assertEqual(order, ["a", "b", "c"])
            self.assertEqual((told["c"], told["d"]), ([1, None], [2, 1]))
            for name in "bcd":
                release[name].set()
            await asyncio.gather(*tasks.values())
            self.assertEqual(order, ["a", "b", "c", "d"])

        asyncio.run(scenario())

    def test_a_cancelled_wait_leaves_the_queue_and_a_full_queue_refuses(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            hold = asyncio.Event()

            async def holder() -> None:
                async with gate.slot(lambda _place: None, _limit):
                    await hold.wait()

            running = asyncio.create_task(holder())
            await asyncio.sleep(0)
            places: list[int | None] = []
            waiting = asyncio.create_task(holder())
            behind = asyncio.create_task(self._enter(gate, places))
            await asyncio.sleep(0)
            self.assertEqual(places, [2])
            # Stop of the first waiter: it leaves at once, and the one behind moves up.
            waiting.cancel()
            await asyncio.gather(waiting, return_exceptions=True)
            self.assertEqual(places, [2, 1])
            with mock.patch.object(chat_gate, "MAX_WAITING", 1), self.assertRaises(chat_gate.QueueFullError):
                async with gate.slot(lambda _place: None, _limit):
                    raise AssertionError("an operation ran past a full queue")
            hold.set()
            await asyncio.gather(running, behind)
            self.assertEqual(places, [2, 1, None])

        asyncio.run(scenario())

    async def _enter(self, gate: chat_gate.Gate, places: list[int | None]) -> None:
        async with gate.slot(places.append, _limit):
            pass

    def test_a_higher_limit_starts_waiters_and_a_lower_one_lets_running_work_drain(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            hold = asyncio.Event()
            started: list[str] = []

            async def operation(name: str) -> None:
                async with gate.slot(lambda _place: None, _limit):
                    started.append(name)
                    await hold.wait()

            tasks = [asyncio.create_task(operation(name)) for name in "abc"]
            await asyncio.sleep(0)
            self.assertEqual(started, ["a"])
            gate.set_limit(2)
            await asyncio.sleep(0)
            self.assertEqual(started, ["a", "b"])
            gate.set_limit(1)
            await asyncio.sleep(0)
            # Nothing running is stopped; nothing more starts until fewer than the limit run.
            self.assertEqual(started, ["a", "b"])
            hold.set()
            await asyncio.gather(*tasks)
            self.assertEqual(started, ["a", "b", "c"])

        asyncio.run(scenario())

    def test_a_busy_space_puts_the_operation_back_at_the_head_and_stop_meanwhile_gives_nothing_back_twice(
        self,
    ) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            order: list[str] = []
            proceed = asyncio.Event()

            async def first() -> None:
                async with gate.slot(lambda _place: None, _limit) as held:
                    order.append("first")
                    await proceed.wait()
                    # Team said the Space is busy: wait, then ask again ahead of everyone who queued meanwhile.
                    await held.busy()
                    order.append("first again")

            async def second() -> None:
                async with gate.slot(lambda _place: None, _limit):
                    order.append("second")

            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 0):
                one = asyncio.create_task(first())
                await asyncio.sleep(0)
                two = asyncio.create_task(second())
                await asyncio.sleep(0)
                proceed.set()
                await asyncio.gather(one, two)
            # The released slot went to the waiter; the busy operation then took the head of the queue.
            self.assertEqual(order, ["first", "second", "first again"])

            stopped = asyncio.Event()

            async def stopped_while_busy() -> None:
                async with gate.slot(lambda _place: None, _limit) as held:
                    stopped.set()
                    await held.busy()

            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 60):
                task = asyncio.create_task(stopped_while_busy())
                await stopped.wait()
                await asyncio.sleep(0)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            # The slot it gave back is not given back again: the next operation runs at once.
            async with gate.slot(lambda _place: None, _limit):
                order.append("after")
            self.assertEqual(order[-1], "after")

        asyncio.run(scenario())

    def test_a_wait_cancelled_as_it_was_granted_passes_its_slot_on(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            release = asyncio.Event()

            async def holder() -> None:
                async with gate.slot(lambda _place: None, _limit):
                    await release.wait()

            running = asyncio.create_task(holder())
            await asyncio.sleep(0)
            granted = asyncio.create_task(holder())
            await asyncio.sleep(0)
            release.set()
            await running
            # Granted and cancelled in the same step: its slot goes on, so the gate is free again.
            granted.cancel()
            await asyncio.gather(granted, return_exceptions=True)
            async with gate.slot(lambda _place: None, _limit):
                pass

        asyncio.run(scenario())

    def test_operations_resting_after_a_busy_space_still_count_against_the_queue(self) -> None:
        async def scenario() -> None:
            gate = chat_gate.Gate()
            gate.set_limit(1)
            resting = asyncio.Event()

            async def busy() -> None:
                async with gate.slot(lambda _place: None, _limit) as held:
                    resting.set()
                    await held.busy()

            with mock.patch.object(chat_gate, "BUSY_RETRY_SECONDS", 60), mock.patch.object(chat_gate, "MAX_WAITING", 1):
                task = asyncio.create_task(busy())
                await resting.wait()
                await asyncio.sleep(0)
                # The resting operation gave its slot back yet fills the queue's one place: a new one is refused.
                with self.assertRaises(chat_gate.QueueFullError):
                    async with gate.slot(lambda _place: None, _limit):
                        raise AssertionError("an operation queued past the bound")
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            async with gate.slot(lambda _place: None, _limit):
                pass

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
