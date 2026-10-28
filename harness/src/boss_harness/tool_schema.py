"""显式工具参数使用的受限 JSON Schema 校验；仅按 schema 解码结构化字符串，不填默认值。

支持 type（单类型）、properties、required、additionalProperties（布尔）、enum、
anyOf、数值上下界、字符串长度及 Python re.search pattern、items、数组长度与
uniqueItems。description/title/default 仅为注释；其余关键字在注册时拒绝。
不支持引用、隐式标量转换或完整 JSON Schema 方言。
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Mapping
from typing import Any


_SCHEMA_ERROR = "工具参数 schema 无效或包含不支持的规则"
_ARGUMENT_ERROR = "工具参数不符合已注册的 schema"
_MAX_SCHEMA_BYTES = 128 * 1024
_MAX_ARGUMENT_BYTES = 1024 * 1024
_MAX_JSON_DEPTH = 64
_MAX_JSON_NODES = 32768
_MAX_SCHEMA_DEPTH = 32
_MAX_NORMALIZATION_VISITS = _MAX_JSON_NODES * 2
_TYPES = frozenset({"string", "integer", "number", "boolean", "null", "object", "array"})
_INVALID_STRUCTURED_JSON = object()
_KEYWORDS = frozenset({"type", "properties", "required", "additionalProperties", "enum", "anyOf",
    "minimum", "maximum", "minLength", "maxLength", "pattern", "items", "minItems", "maxItems",
    "uniqueItems", "description", "title", "default"})


def _json_snapshot(value: Any, *, maximum: int, allow_mappings: bool = False) -> str:
    """Copy JSON values without json.dumps coercing tuples or non-string keys."""
    active: set[int] = set()
    nodes = 0
    characters = 0

    def account(size: int) -> None:
        nonlocal characters
        characters += size
        if characters > maximum:
            raise ValueError

    def copy(item: Any, depth: int) -> Any:
        nonlocal nodes
        nodes += 1
        if depth > _MAX_JSON_DEPTH or nodes > _MAX_JSON_NODES:
            raise ValueError
        if type(item) is str:
            account(len(item) + 2)
            return item
        if item is None or type(item) in {bool, int}:
            account(len(json.dumps(item)))
            return item
        if type(item) is float:
            if not math.isfinite(item):
                raise ValueError
            account(len(json.dumps(item)))
            return item
        is_object = isinstance(item, Mapping) if allow_mappings else type(item) is dict
        if is_object or type(item) is list:
            marker = id(item)
            if marker in active:
                raise ValueError
            active.add(marker)
            try:
                account(2)
                if is_object:
                    result = {}
                    for index, (key, child) in enumerate(item.items()):
                        if type(key) is not str:
                            raise ValueError
                        account(len(key) + 3 + bool(index))
                        result[key] = copy(child, depth + 1)
                    return result
                copied = []
                for index, child in enumerate(item):
                    account(bool(index))
                    copied.append(copy(child, depth + 1))
                return copied
            finally:
                active.remove(marker)
        raise ValueError

    normalized = copy(value, 0)
    encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    if len(encoded.encode("utf-8")) > maximum:
        raise ValueError
    return encoded


def _identity(value: Any) -> tuple:
    # Hashable JSON equality keeps numeric 1/1.0 equal and True/1 distinct.
    if type(value) in {int, float}:
        return ("number", value)
    if type(value) is dict:
        return ("object", tuple((key, _identity(value[key])) for key in sorted(value)))
    if type(value) is list:
        return ("array", tuple(_identity(child) for child in value))
    return (type(value).__name__, value)


def _validate_schema(rule: Any, depth: int = 0) -> None:
    if depth > _MAX_SCHEMA_DEPTH or type(rule) is not dict or set(rule) - _KEYWORDS:
        raise ValueError
    if "type" in rule and (type(rule["type"]) is not str or rule["type"] not in _TYPES):
        raise ValueError
    for key in ("description", "title"):
        if key in rule and type(rule[key]) is not str:
            raise ValueError
    if "properties" in rule:
        if type(rule["properties"]) is not dict:
            raise ValueError
        for child in rule["properties"].values():
            _validate_schema(child, depth + 1)
    if "required" in rule:
        required = rule["required"]
        if (type(required) is not list or any(type(key) is not str for key in required)
                or len(set(required)) != len(required)):
            raise ValueError
    for key in ("additionalProperties", "uniqueItems"):
        if key in rule and type(rule[key]) is not bool:
            raise ValueError
    if "enum" in rule:
        choices = rule["enum"]
        if (type(choices) is not list or not choices
                or len({_identity(choice) for choice in choices}) != len(choices)):
            raise ValueError
    if "anyOf" in rule:
        if type(rule["anyOf"]) is not list or not rule["anyOf"]:
            raise ValueError
        for child in rule["anyOf"]:
            _validate_schema(child, depth + 1)
    for key in ("minimum", "maximum"):
        if key in rule and type(rule[key]) not in {int, float}:
            raise ValueError
    for key in ("minLength", "maxLength", "minItems", "maxItems"):
        if key in rule and (type(rule[key]) is not int or rule[key] < 0):
            raise ValueError
    for lower, upper in (("minimum", "maximum"), ("minLength", "maxLength"), ("minItems", "maxItems")):
        if lower in rule and upper in rule and rule[lower] > rule[upper]:
            raise ValueError
    if "pattern" in rule:
        if type(rule["pattern"]) is not str:
            raise ValueError
        re.compile(rule["pattern"])
    if "items" in rule:
        _validate_schema(rule["items"], depth + 1)


def canonical_schema(schema: Mapping[str, Any]) -> str:
    """Validate a root object schema and return an immutable canonical snapshot."""
    try:
        if not isinstance(schema, Mapping):
            raise ValueError
        encoded = _json_snapshot(schema, maximum=_MAX_SCHEMA_BYTES, allow_mappings=True)
        normalized = json.loads(encoded)
        if normalized.get("type") != "object":
            raise ValueError
        _validate_schema(normalized)
        return encoded
    except Exception:
        raise ValueError(_SCHEMA_ERROR) from None


def _matches(rule: dict[str, Any], value: Any) -> bool:
    kind = rule.get("type")
    if kind is not None:
        valid = {"string": type(value) is str, "integer": type(value) is int,
                 "number": type(value) in {int, float}, "boolean": type(value) is bool,
                 "null": value is None, "object": type(value) is dict, "array": type(value) is list}
        if not valid[kind]:
            return False
    if "enum" in rule and _identity(value) not in {_identity(choice) for choice in rule["enum"]}:
        return False
    if "anyOf" in rule and not any(_matches(child, value) for child in rule["anyOf"]):
        return False
    if type(value) in {int, float}:
        if "minimum" in rule and value < rule["minimum"]:
            return False
        if "maximum" in rule and value > rule["maximum"]:
            return False
    if type(value) is str:
        if len(value) < rule.get("minLength", 0) or len(value) > rule.get("maxLength", len(value)):
            return False
        if "pattern" in rule and re.search(rule["pattern"], value) is None:
            return False
    if type(value) is dict:
        properties = rule.get("properties", {})
        if any(key not in value for key in rule.get("required", [])):
            return False
        if rule.get("additionalProperties", True) is False and set(value) - set(properties):
            return False
        if any(key in properties and not _matches(properties[key], child) for key, child in value.items()):
            return False
    if type(value) is list:
        if len(value) < rule.get("minItems", 0) or len(value) > rule.get("maxItems", len(value)):
            return False
        if "items" in rule and any(not _matches(rule["items"], child) for child in value):
            return False
        if rule.get("uniqueItems", False) and len({_identity(child) for child in value}) != len(value):
            return False
    return True


def _reject_json_constant(value: str) -> None:
    raise ValueError(f"非法 JSON 常量: {value}")


def _account_decoded_nodes(value: Any, state: dict[str, Any], depth: int = 0) -> None:
    state["decoded_nodes"] += 1
    if depth > _MAX_JSON_DEPTH or state["decoded_nodes"] > _MAX_JSON_NODES:
        raise ValueError
    if type(value) is dict:
        for child in value.values():
            _account_decoded_nodes(child, state, depth + 1)
    elif type(value) is list:
        for child in value:
            _account_decoded_nodes(child, state, depth + 1)


def _normalize_structured_value(rule: dict[str, Any], value: Any, state: dict[str, Any],
                                schema_depth: int = 0) -> Any:
    """Decode only JSON strings whose schema-selected object/array form validates."""
    state["visits"] += 1
    if state["visits"] > _MAX_NORMALIZATION_VISITS:
        raise ValueError
    if schema_depth > _MAX_SCHEMA_DEPTH:
        raise ValueError

    branches = rule.get("anyOf")
    if branches is not None:
        if _matches(rule, value):
            return value
        for branch in branches:
            candidate = _normalize_structured_value(branch, value, state, schema_depth + 1)
            if _matches(rule, candidate):
                return candidate
        return value

    kind = rule.get("type")
    if type(value) is str:
        if _matches(rule, value) or kind not in {"object", "array"}:
            return value
        text = value.strip()
        expected_prefix = "{" if kind == "object" else "["
        if not text.startswith(expected_prefix):
            return value
        parsed_values = state["parsed_values"]
        if text not in parsed_values:
            try:
                parsed = json.loads(text, parse_constant=_reject_json_constant)
                _account_decoded_nodes(parsed, state)
                parsed_values[text] = parsed
            except (TypeError, ValueError, RecursionError):
                parsed_values[text] = _INVALID_STRUCTURED_JSON
        parsed = parsed_values[text]
        if parsed is _INVALID_STRUCTURED_JSON:
            return value
        expected_type = dict if kind == "object" else list
        if type(parsed) is not expected_type:
            return value
        candidate = _normalize_structured_value(rule, parsed, state, schema_depth)
        return candidate if _matches(rule, candidate) else value

    if type(value) is dict:
        properties = rule.get("properties", {})
        return {key: (_normalize_structured_value(properties[key], child, state, schema_depth + 1)
                      if key in properties else child)
                for key, child in value.items()}
    if type(value) is list and "items" in rule:
        return [_normalize_structured_value(rule["items"], child, state, schema_depth + 1)
                for child in value]
    return value


def validated_arguments(schema_json: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Return an independent schema-validated copy, decoding required structures only."""
    try:
        if type(arguments) is not dict:
            raise ValueError
        copied = json.loads(_json_snapshot(arguments, maximum=_MAX_ARGUMENT_BYTES))
        schema = json.loads(schema_json)
        state: dict[str, Any] = {"decoded_nodes": 0, "parsed_values": {}, "visits": 0}
        normalized = _normalize_structured_value(schema, copied, state)
        validated = json.loads(_json_snapshot(normalized, maximum=_MAX_ARGUMENT_BYTES))
        if not _matches(schema, validated):
            raise ValueError
        return validated
    except Exception:
        raise ValueError(_ARGUMENT_ERROR) from None
