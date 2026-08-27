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
    requests: list[LlmRequest] = []

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.calls += 1
        self.requests.append(llm_request)
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


async def test_action_budget_from_state_blocks_the_next_browser_call() -> None:
    from dayflow.agents.orchestrator import ACTIONS_KEY, MAX_ACTIONS

    script = [[fc("c1", "open_tab", url="https://wsp.kbtu.kz")], [fc("c2", "click", ref="e1")], [txt("Over budget.")]]
    runner, llm = make_runner(script)
    await collect(runner, [txt("go")])
    session = await runner.session_service.get_session(app_name="dayflow", user_id="u", session_id="s")
    assert session is not None and ACTIONS_KEY not in session.state, "no state survives a pending long-running call"
    fr = types.Part(function_response=types.FunctionResponse(id="c1", name="open_tab", response={"tab": 41}))
    events = [
        ev
        async for ev in runner.run_async(
            user_id="u",
            session_id="s",
            new_message=types.Content(role="user", parts=[fr]),
            state_delta={ACTIONS_KEY: MAX_ACTIONS},  # what /tool_result books via result_state_delta
        )
    ]
    frs = [fr for ev in events for fr in ev.get_function_responses()]
    assert frs and frs[0].id == "c2" and "budget exhausted" in str(frs[0].response)
    assert llm.calls == 3 and final_text(events[-1]) == "Over budget."


async def test_screenshot_part_reaches_the_model_as_an_image() -> None:
    runner, llm = make_runner([[fc("c1", "click", ref="e2")], [txt("I see the folder opened.")]])
    await collect(runner, [txt("go")])
    blob = types.FunctionResponseBlob(mime_type="image/jpeg", data=b"\xff\xd8\xff\x00")
    fr = types.Part(
        function_response=types.FunctionResponse(
            id="c1", name="click", response={"clicked": True}, parts=[types.FunctionResponsePart(inline_data=blob)]
        )
    )
    events = await collect(runner, [fr])
    assert final_text(events[-1]) == "I see the folder opened."
    parts = [p for c in llm.requests[-1].contents for p in (c.parts or []) if p.function_response]
    assert parts and parts[-1].function_response is not None
    inline = parts[-1].function_response.parts
    assert inline and inline[0].inline_data is not None and inline[0].inline_data.data == b"\xff\xd8\xff\x00"


async def test_remember_tool_writes_the_users_memory_for_the_next_turn() -> None:
    store = MemoryConfigStore()
    agent = build_root_agent(store)
    note = "CSCI3240: no files on WSP, materials on Teams"
    llm = ScriptedLlm(script=[[fc("m1", "remember", note=note)], [txt("Noted.")]])
    agent.model = llm
    runner = Runner(
        app=App(name="dayflow", root_agent=agent), session_service=InMemorySessionService(), auto_create_session=True
    )
    events = await collect(runner, [txt("the CV course has no WSP folder")])
    assert final_text(events[-1]) == "Noted."
    frs = [fr for ev in events for fr in ev.get_function_responses()]
    assert frs and frs[0].response and frs[0].response.get("status") == "success"
    assert (await store.get("u")).memory == "- CSCI3240: no files on WSP, materials on Teams"
    # The remembered line is in the system instruction of the NEXT model call in this conversation.
    llm.script.append([txt("ok")])
    await collect(runner, [txt("and now?")])
    instruction = llm.requests[-1].config.system_instruction if llm.requests[-1].config else None
    assert instruction and "no files on WSP" in str(instruction)


async def test_older_screenshots_are_pruned_from_the_model_request() -> None:
    from dayflow.agents.orchestrator import KEEP_SCREENSHOTS

    n = KEEP_SCREENSHOTS + 2
    script: list[list[types.Part]] = [[fc(f"c{i}", "click", ref=f"e{i}")] for i in range(n)] + [[txt("done")]]
    runner, llm = make_runner(script)
    await collect(runner, [txt("go")])
    for i in range(n):
        blob = types.FunctionResponseBlob(mime_type="image/jpeg", data=bytes([i]))
        shot = [types.FunctionResponsePart(inline_data=blob)]
        fr = types.FunctionResponse(id=f"c{i}", name="click", response={"clicked": True}, parts=shot)
        await collect(runner, [types.Part(function_response=fr)])
    frs = [p.function_response for c in llm.requests[-1].contents for p in (c.parts or []) if p.function_response]
    assert len(frs) == n
    assert [bool(fr.parts) for fr in frs] == [False] * 2 + [True] * KEEP_SCREENSHOTS
    assert all("dropped" in str(fr.response.get("screenshot")) for fr in frs[:2] if fr.response)


async def test_active_skill_restricts_the_declared_tools() -> None:
    from dayflow.agents.orchestrator import SKILL_KEY

    runner, llm = make_runner([[txt("ok")]])
    events = [
        ev
        async for ev in runner.run_async(
            user_id="u",
            session_id="s",
            new_message=types.Content(role="user", parts=[txt("go")]),
            state_delta={SKILL_KEY: "pitch-deck"},
        )
    ]
    assert final_text(events[-1]) == "ok"
    tools = llm.requests[-1].config.tools or []
    names = {d.name for t in tools if isinstance(t, types.Tool) for d in (t.function_declarations or [])}
    assert {"build_deck", "download", "open_tab", "vault_list", "remember"} <= names  # GitHub toolset needs env
    assert "create_pull_request" not in names and "solve_lab_task" not in names and len(names) < 15
