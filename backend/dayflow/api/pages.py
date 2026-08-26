"""GET /pages/{kind}/{id}: HTML artifacts from the PageStore. No auth — ids are unguessable."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse

from dayflow.core.pages import PageStore

router = APIRouter(prefix="/pages", tags=["pages"])


@router.get("/{kind}/{page_id}", response_class=HTMLResponse)
async def get_page(kind: str, page_id: str, request: Request) -> HTMLResponse:
    pages: PageStore = request.app.state.pages
    html = await pages.get(kind, page_id)
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such page")
    return HTMLResponse(html, headers={"Cache-Control": "private, max-age=300"})
