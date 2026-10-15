"""Admission of the JSON object a browser request carries."""

from fastapi import HTTPException


def exact_fields(payload: dict, *names: str) -> dict:
    """Return `payload` when it holds exactly the fields `names`; any other body is the request's own 400."""
    if set(payload) != set(names):
        raise HTTPException(status_code=400, detail=f"request body must contain only {' and '.join(names)}")
    return payload
