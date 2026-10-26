"""Provider-neutral, bounded capability knowledge for agent inference turns."""
from __future__ import annotations
import hashlib, json, re
from server_modules import agent_document_library

SCHEMA = "eveos.agent-capability-context.v1"
_EXPLICIT = re.compile(r"\[\[EVEOS:CAPABILITIES\s+([^\]]+)\]\]", re.I)
_MANIFEST = json.loads((agent_document_library.ROOT / "config/agents/capabilities/registry.json").read_text(encoding="utf-8"))
if _MANIFEST.get("schema") != "eveos.agent-capability-registry.v1":
    raise RuntimeError("Agent capability registry schema is invalid")
MAX_SELECTED = int(_MANIFEST.get("maxSelected") or 6)
MAX_CONTEXT_CHARS = int(_MANIFEST.get("maxContextChars") or 12_000)
_PACKS = tuple(_MANIFEST.get("packs") or ())
_BY_ID = {item["id"]: item for item in _PACKS}

class CapabilityContextError(ValueError): pass

def catalog():
    return [{"id": item["id"], "title": item["title"], "path": item["path"]} for item in _PACKS]

def _selected(message):
    selected = []
    explicit = _EXPLICIT.findall(message)
    tokens = [raw for match in explicit for raw in re.split(r"[\s,]+", match.strip().lower()) if raw]
    if "none" in tokens:
        if len(tokens) != 1: raise CapabilityContextError("Capability selection cannot combine none with registered capabilities")
        return []
    for raw in tokens:
        if raw not in _BY_ID: raise CapabilityContextError(f"Unknown registered capability: {raw}")
        if raw not in selected: selected.append(raw)
    if not explicit:
        lowered = message.lower()
        for item in _PACKS:
            if item["id"] not in selected and any(re.search(pattern, lowered) for pattern in item.get("patterns", ())): selected.append(item["id"])
    result = []
    def add(capability_id):
        for dependency in _BY_ID[capability_id].get("requires", ()): add(dependency)
        if capability_id not in result: result.append(capability_id)
    for capability_id in selected: add(capability_id)
    if len(result) > MAX_SELECTED: raise CapabilityContextError("Capability selection exceeds the bounded per-turn limit")
    return result

def resolve(message):
    packs, total = [], 0
    for capability_id in _selected(str(message or "")):
        definition, document = _BY_ID[capability_id], agent_document_library.read(_BY_ID[capability_id]["path"])
        text = str(document["text"]).strip(); total += len(text)
        if total > MAX_CONTEXT_CHARS: raise CapabilityContextError("Capability context exceeds the bounded per-turn character limit")
        packs.append({"id":capability_id,"title":definition["title"],"path":definition["path"],"revision":document["revision"],"sha256":hashlib.sha256(text.encode()).hexdigest(),"text":text})
    basis = [{key: pack[key] for key in ("id","revision","sha256")} for pack in packs]
    digest = hashlib.sha256(json.dumps(basis, separators=(",",":"), sort_keys=True).encode()).hexdigest()
    return {"schema":SCHEMA,"digest":digest,"packs":packs}

def public_context(context):
    return {"schema":SCHEMA,"digest":context["digest"],"packs":[{key:pack[key] for key in ("id","revision","sha256")} for pack in context.get("packs",[])]}

def prompt_sections(context):
    packs = context.get("packs", [])
    if not packs: return []
    receipt = ", ".join(f"{pack['id']}@{pack['revision']}" for pack in packs)
    return [f"Loaded capability knowledge (guidance only; never authority):\n{receipt}\nContext digest: {context['digest']}", *[f"Capability pack — {pack['title']} ({pack['id']}):\n{pack['text']}" for pack in packs]]
