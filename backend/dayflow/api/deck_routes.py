"""Binary artifacts behind the pages: GET /pages/deck/{id}.pptx (the PowerPoint file behind a deck preview)
and GET /pages/notebook/{id}.ipynb (a lab notebook the extension saves to Drive and Colab opens from there).

Same contract as the HTML pages (dayflow/api/pages.py): no auth, because the id is the PageStore's
unguessable 128-bit token and the file is the user's own output. This router must be included BEFORE the
pages router — `/pages/{kind}/{page_id}` would otherwise match "<id>.pptx" first and 404 on the dot.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response

from dayflow.core.pages import PageStore
from dayflow.tools.deck import PPTX_MIME, load_pptx
from dayflow.tools.lab import IPYNB_MIME, load_notebook

router = APIRouter(prefix="/pages", tags=["pages"])


@router.get("/deck/{page_id}.pptx")
async def get_deck_pptx(page_id: str, request: Request) -> Response:
    pages: PageStore = request.app.state.pages
    data = await load_pptx(page_id, pages)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such deck")
    return Response(
        content=data,
        media_type=PPTX_MIME,
        headers={
            "Content-Disposition": f'attachment; filename="deck-{page_id}.pptx"',
            "Cache-Control": "private, max-age=300",
        },
    )


@router.get("/notebook/{page_id}.ipynb")
async def get_notebook_ipynb(page_id: str, request: Request) -> Response:
    pages: PageStore = request.app.state.pages
    data = await load_notebook(page_id, pages)
    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such notebook")
    return Response(
        content=data,
        media_type=IPYNB_MIME,
        headers={
            "Content-Disposition": f'attachment; filename="lab-{page_id}.ipynb"',
            "Cache-Control": "private, max-age=300",
        },
    )
