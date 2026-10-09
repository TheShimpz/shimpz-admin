"""Build Team's catalog-reference human requests and their rendered copy from plain test copy (ADR-0091)."""

import hashlib
import json

PACK_DIGEST = "sha256:" + "5" * 64
COPY_FIELDS = ("title", "description", "label", "placeholder")


def reference(text: str, **params: object) -> dict[str, object]:
    """A reference to the English message whose id is the SHA-256 of its exact template bytes."""
    return {"message": hashlib.sha256(text.encode()).hexdigest(), "params": params}


def fingerprint(request: dict[str, object]) -> str:
    canonical = json.dumps(request, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def localize(plain: dict[str, object]) -> tuple[dict[str, object], dict[str, object]]:
    """Return the fingerprinted canonical request with references and the rendered copy of the same text."""
    request = {key: value for key, value in plain.items() if key != "fingerprint"}
    rendered: dict[str, object] = {}
    for field in COPY_FIELDS:
        if field in request:
            text = request[field]
            rendered[field] = text
            request[field] = None if text is None else reference(text)
    if "options" in request:
        rendered["options"] = [
            {"label": option["label"], "description": option["description"]} for option in request["options"]
        ]
        request["options"] = [
            {
                "value": option["value"],
                "label": reference(option["label"]),
                "description": None if option["description"] is None else reference(option["description"]),
            }
            for option in request["options"]
        ]
    return {**request, "fingerprint": fingerprint(request)}, rendered


def rendered_for(request: object) -> object:
    """Bounded display copy for exactly the copy fields of any canonical request shape, null where it is null."""
    if not isinstance(request, dict):
        return {}
    rendered: dict[str, object] = {
        field: None if request[field] is None else f"Rendered {field}" for field in COPY_FIELDS if field in request
    }
    options = request.get("options")
    if isinstance(options, list):
        rendered["options"] = [
            {
                "label": f"Rendered option {index}",
                "description": None
                if isinstance(option, dict) and option.get("description") is None
                else f"Rendered description {index}",
            }
            for index, option in enumerate(options)
        ]
    return rendered


def localization(rendered: object, locale: str = "en") -> dict[str, object]:
    """The required localization fields of a challenge beside its canonical request."""
    return {"rendered": rendered, "locale": locale, "pack_digest": PACK_DIGEST}
