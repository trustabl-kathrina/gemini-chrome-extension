"""Long-running browser tools against the real ADK Runner with a scripted LLM."""

from collections.abc import AsyncGenerator
from typing import Any

from google.adk.apps import App
from google.adk.events import Event
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from dayflow.agents.orchestrator import build_root_agent
from dayflow.core.loader import MemoryConfigStore


class ScriptedLlm(BaseLlm):
    model: str = "scripted"
    script: list[list[types.Part]] = []
    calls: int = 0

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        yield LlmResponse(content=types.Content(role="model", parts=self.script.pop(0)))


def fc(id_: str, name: str, **args: Any) -> types.Part:
    return types.Part(function_call=types.FunctionCall(id=id_, name=name, args=args))


def txt(t: str) -> types.Part:
    return types.Part(text=t)


def final_text(ev: Event) -> str:
    parts = ev.content.parts if ev.content and ev.content.parts else []
    return "".join(p.text or "" for p in parts)


def make_runner(script: list[list[types.Part]]) -> tuple[Runner, ScriptedLlm]:
    agent = build_root_agent(MemoryConfigStore())
    llm = ScriptedLlm(script=script)
    agent.model = llm
    runner = Runner(
        app=App(name="dayflow", root_agent=agent), session_service=InMemorySessionService(), auto_create_session=True
    )
    return runner, llm


async def collect(runner: Runner, parts: list[types.Part]) -> list[Event]:
    return [
        ev
        async for ev in runner.run_async(
            user_id="u", session_id="s", new_message=types.Content(role="user", parts=parts)
        )
    ]


async def test_browser_tool_call_ends_the_turn_without_a_fake_response() -> None:
    runner, llm = make_runner([[fc("c1", "open_tab", url="https://wsp.kbtu.kz")], [txt("should not run")]])
    events = await collect(runner, [txt("go")])
    last = events[-1]
    assert [f.id for f in last.get_function_calls()] == ["c1"]
    assert last.long_running_tool_ids == {"c1"}
    assert last.is_final_response()
    assert not any(ev.get_function_responses() for ev in events), "no auto FunctionResponse for a pending call"
    assert llm.calls == 1 and len(llm.script) == 1, "model must not be called again until the extension answers"


async def test_tool_result_resumes_the_same_invocation() -> None:
    runner, llm = make_runner([[fc("c1", "open_tab", url="https://wsp.kbtu.kz")], [txt("Done.")]])
    first = await collect(runner, [txt("go")])
    fr = types.Part(function_response=types.FunctionResponse(id="c1", name="open_tab", response={"tab": 41}))
    second = await collect(runner, [fr])
    assert llm.calls == 2 and final_text(second[-1]) == "Done."
    assert second[-1].invocation_id == first[-1].invocation_id


async def test_guard_error_is_returned_to_the_model_immediately() -> None:
    runner, llm = make_runner([[fc("c7", "navigate", url="https://evil.com/x")], [txt("blocked, ok")]])
    events = await collect(runner, [txt("go evil")])
    frs = [fr for ev in events for fr in ev.get_function_responses()]
    assert frs and frs[0].id == "c7" and "allow-list" in str(frs[0].response)
    # ADK still flags the FC event as long-running; the FR that follows in the SAME stream is what tells the
    # extension the call is not pending. (Extension rule: a call is pending only if no FR for it arrives.)
    assert events[0].long_running_tool_ids == {"c7"}
    assert llm.calls == 2 and final_text(events[-1]) == "blocked, ok"
