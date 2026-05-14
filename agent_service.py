"""
Embedded financial assistant service.

This is a Python adaptation of the previous FinancialApp agent chain:
text/voice input -> Gemini function calling -> app action -> streamed final
response -> optional TTS and background discount lookup.
"""

from __future__ import annotations

import base64
import json
import os
import re
import smtplib
import ssl
import struct
import threading
import urllib.parse
import urllib.request
import uuid
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from typing import Any

from agent_env import load_agent_env
import agent_realtime as realtime


load_agent_env()


DEFAULT_MODEL = "gemini-2.5-flash"
DEFAULT_TRANSCRIPTION_MODEL = "gemini-3-flash-preview"
FALLBACK_TRANSCRIPTION_MODEL = "gemini-2.5-flash"
DEFAULT_TTS_MODEL = "gemini-3.1-flash-tts-preview"
FALLBACK_TTS_MODEL = "gemini-2.5-flash-preview-tts"
DEFAULT_TTS_VOICE = "Iapetus"
UNSUPPORTED_LANGUAGE_TOKEN = "UNSUPPORTED_LANGUAGE"
DEFAULT_LOCATION = "Munich, Germany"

SUPPORTED_FUNCTIONS = [
    "create_expense",
    "delete_expense",
    "create_wishlist_item",
    "get_wishlist",
    "send_email",
    "lookup_store_product",
    "lookup_retail_offers",
    "lookup_local_deals",
    "update_profile",
    "get_profile",
    "get_spending_summary",
    "get_financial_overview",
    "unsupported",
]

SUPPORTED_CURRENCIES = ["EUR", "USD", "GBP", "CNY", "CHF", "JPY", "AUD", "CAD", "HKD", "SGD"]
SUPPORTED_PERIODS = ["today", "current_week", "current_month", "all_time"]
SUPPORTED_PRIORITIES = ["low", "medium", "high"]
DEFAULT_CATEGORIES = [
    "Banking & Fees",
    "Entertainment & Subscriptions",
    "Food & Beverage",
    "Groceries",
    "Health & Wellness",
    "Home & Living",
    "Personal Care",
    "Pet Supplies",
    "Shopping",
    "Transport",
    "Others",
]
CATEGORY_ALIASES = {
    "food": "Food & Beverage",
    "restaurant": "Food & Beverage",
    "coffee": "Food & Beverage",
    "groceries": "Groceries",
    "grocery": "Groceries",
    "transport": "Transport",
    "shopping": "Shopping",
    "bills": "Banking & Fees",
    "entertainment": "Entertainment & Subscriptions",
    "health": "Health & Wellness",
    "home": "Home & Living",
    "personal": "Personal Care",
    "pet": "Pet Supplies",
    "other": "Others",
    "others": "Others",
    "餐": "Food & Beverage",
    "饭": "Food & Beverage",
    "咖啡": "Food & Beverage",
    "超市": "Groceries",
    "交通": "Transport",
    "购物": "Shopping",
}

RETAILERS = {
    "mediamarkt": {
        "name": "MediaMarkt",
        "domains": ["mediamarkt.de"],
        "offerPages": [
            "https://www.mediamarkt.de/de/campaign/angebote-aktionen",
            "https://www.mediamarkt.de/de/specials",
        ],
    },
    "saturn": {
        "name": "Saturn",
        "domains": ["saturn.de"],
        "offerPages": [
            "https://www.saturn.de/de/campaign/angebote-aktionen",
            "https://www.saturn.de/de/specials",
        ],
    },
    "edeka": {
        "name": "EDEKA",
        "domains": ["edeka.de"],
        "offerPages": ["https://www.edeka.de/eh/angebote.jsp"],
    },
    "rewe": {
        "name": "REWE",
        "domains": ["rewe.de"],
        "offerPages": ["https://www.rewe.de/angebote/"],
    },
    "penny": {
        "name": "PENNY",
        "domains": ["penny.de"],
        "offerPages": ["https://www.penny.de/angebote"],
    },
    "lidl": {
        "name": "Lidl",
        "domains": ["lidl.de"],
        "offerPages": ["https://www.lidl.de/c/angebote"],
    },
    "aldi": {
        "name": "ALDI SUD",
        "domains": ["aldi-sued.de"],
        "offerPages": ["https://www.aldi-sued.de/de/angebote.html"],
    },
    "rossmann": {
        "name": "ROSSMANN",
        "domains": ["rossmann.de"],
        "offerPages": ["https://www.rossmann.de/de/angebote"],
    },
    "ikea": {
        "name": "IKEA",
        "domains": ["ikea.com/de/de"],
        "offerPages": ["https://www.ikea.com/de/de/offers/"],
    },
    "asian_grocery": {
        "name": "Asian grocery stores",
        "domains": [],
        "offerPages": [],
    },
}
SUPPORTED_RETAILER_IDS = [*RETAILERS.keys(), "all_supported"]

KNOWN_LOCAL_MERCHANTS = {
    "mcdonalds": {
        "name": "McDonald's",
        "aliases": ["mcdonalds", "mcdonald's", "mcdonald", "麦当劳", "麥當勞"],
        "dealPages": [
            "https://www.mcdonalds.com/de/de-de/angebote.html",
            "https://www.mcdonalds.com/de/de-de/app.html",
        ],
    },
    "burger_king": {
        "name": "Burger King",
        "aliases": ["burger king", "汉堡王", "漢堡王"],
        "dealPages": ["https://www.burgerking.de/coupons"],
    },
    "kfc": {
        "name": "KFC",
        "aliases": ["kfc", "肯德基"],
        "dealPages": ["https://www.kfc.de/angebote"],
    },
    "subway": {
        "name": "Subway",
        "aliases": ["subway", "赛百味", "賽百味"],
        "dealPages": [],
    },
    "starbucks": {
        "name": "Starbucks",
        "aliases": ["starbucks", "星巴克"],
        "dealPages": [],
    },
}


def handle_assistant_request(body: dict[str, Any]) -> tuple[dict[str, Any], int]:
    message = str(body.get("message") or "").strip()
    client_id = normalize_text(body.get("clientId"))
    input_mode = "voice" if body.get("inputMode") == "voice" else "text"
    response_language = normalize_response_language(body.get("responseLanguage"))
    client_state = normalize_client_state(body.get("state") or {})

    job = realtime.create_job(
        client_id=client_id,
        job_type="assistant_request",
        label="Assistant request",
        metadata={
            "inputMode": input_mode,
            "responseLanguage": response_language,
            "preview": message[:120],
        },
    )

    if not message:
        realtime.fail_job(job, "message is required")
        return {"error": "message is required", "realtimeJobId": job.get("id") if job else None}, 400

    try:
        realtime.emit_progress(
            job,
            stage="function_calling_started",
            message="Routing user input with Gemini function calling.",
        )
        parsed = parse_assistant_function_call(message, client_state)
        realtime.emit_progress(
            job,
            stage="function_call_selected",
            message=f"Selected function: {parsed['functionCall']['name']}",
            data={"functionCall": parsed["functionCall"]},
        )
        _raise_if_cancelled(job)

        realtime.emit_progress(
            job,
            stage="app_function_started",
            message=f"Running app function: {parsed['functionCall']['name']}",
        )
        execution = execute_assistant_function_call(parsed["functionCall"], client_state, job=job)
        realtime.emit_progress(
            job,
            stage="app_function_done",
            message=f"Finished app function: {execution['executedAction']['functionName']}",
            data={
                "executedAction": execution["executedAction"],
                "mapPlaces": execution["result"].get("mapPlaces", []),
            },
        )
        _raise_if_cancelled(job)

        realtime.emit_progress(job, stage="final_response_started", message="Synthesizing final answer.")
        final_response = compose_final_response_stream(
            input_text=message,
            function_call=parsed["functionCall"],
            execution=execution,
            response_language=response_language,
            job=job,
        )
        _raise_if_cancelled(job)

        result = {
            **execution["result"],
            "toolMessage": execution["result"].get("message", ""),
            "message": final_response["message"],
        }

        post_result = maybe_send_final_answer_by_email(
            input_text=message,
            final_message=final_response["message"],
            client_state=client_state,
        )
        if post_result:
            result["postToolMessage"] = post_result["result"]["message"]
            result["postActionResult"] = post_result["result"]
            result["message"] = f"{result['message']}\n\n{post_result['result']['message']}"

        should_speak = bool(body.get("speak") or input_mode == "voice")
        realtime.emit_progress(
            job,
            stage="speech_started" if should_speak else "response_ready",
            message="Generating speech reply." if should_speak else "Response is ready.",
        )
        speech = synthesize_speech(result["message"], {"responseLanguage": response_language}) if should_speak else None
        background_job = maybe_start_discount_lookup_job(
            client_id=client_id,
            execution=execution,
            response_language=response_language,
        )
        realtime.complete_job(
            job,
            {
                "message": result["message"],
                "hasSpeech": bool(speech and speech.get("ok")),
                "mapPlaces": result.get("mapPlaces", []),
                "backgroundJobs": [background_job] if background_job else [],
            },
        )

        return (
            {
                "realtimeJobId": job.get("id") if job else None,
                "backgroundJobs": [background_job] if background_job else [],
                "input": message,
                "inputMode": input_mode,
                "responseLanguage": response_language,
                "parser": {
                    "provider": parsed["provider"],
                    "model": parsed["model"],
                    "warning": parsed.get("warning"),
                },
                "functionCall": parsed["functionCall"],
                "executedAction": execution["executedAction"],
                "result": result,
                "finalResponse": final_response,
                "speech": speech,
                "statePatch": execution.get("statePatch", {}),
            },
            200,
        )
    except Exception as exc:
        realtime.fail_job(job, exc)
        return {
            "error": "assistant_request_failed",
            "message": str(exc),
            "realtimeJobId": job.get("id") if job else None,
        }, 500


def parse_assistant_function_call(input_text: str, client_state: dict[str, Any]) -> dict[str, Any]:
    categories = client_state.get("categories") or DEFAULT_CATEGORIES
    system_instruction = build_system_instruction(categories)
    function_declarations = build_function_declarations(categories)
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    if not api_key:
        function_call = normalize_function_call(parse_with_rules(input_text, client_state), categories)
        return {
            "provider": "local",
            "model": "rule-parser",
            "functionCall": function_call,
            "warning": "GEMINI_API_KEY is not set. Used local parser.",
        }

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        model = os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
        config = types.GenerateContentConfig(
            temperature=0,
            system_instruction=system_instruction,
            tools=[types.Tool(function_declarations=function_declarations)],
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode="ANY",
                    allowed_function_names=SUPPORTED_FUNCTIONS,
                )
            ),
        )
        response = client.models.generate_content(model=model, contents=input_text, config=config)
        function_call = normalize_function_call(extract_function_call(response), categories)
        return {
            "provider": "gemini",
            "model": model,
            "functionCall": function_call,
        }
    except Exception as exc:
        function_call = normalize_function_call(parse_with_rules(input_text, client_state), categories)
        return {
            "provider": "local",
            "model": "rule-parser",
            "functionCall": function_call,
            "warning": f"Gemini function calling failed. Used local parser: {exc}",
        }


def execute_assistant_function_call(
    function_call: dict[str, Any],
    client_state: dict[str, Any],
    job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    call = normalize_function_call(function_call, client_state.get("categories") or DEFAULT_CATEGORIES)
    name = call["name"]
    args = call["args"]

    if name == "create_expense":
        return create_expense(args, client_state)
    if name == "delete_expense":
        return delete_expense(args, client_state)
    if name == "create_wishlist_item":
        return create_wishlist_item(args, client_state)
    if name == "get_wishlist":
        return get_wishlist(client_state)
    if name == "send_email":
        return send_email_action(args, client_state)
    if name == "lookup_store_product":
        return lookup_store_product_action(args, client_state, job)
    if name == "lookup_retail_offers":
        return lookup_retail_offers_action(args, client_state, job)
    if name == "lookup_local_deals":
        return lookup_local_deals_action(args, client_state, job)
    if name == "update_profile":
        return update_profile(args, client_state)
    if name == "get_profile":
        return get_profile(client_state)
    if name == "get_spending_summary":
        return get_spending_summary(args, client_state)
    if name == "get_financial_overview":
        return get_financial_overview(args, client_state)

    return unsupported(args, client_state)


def create_expense(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    amount = to_float(args.get("amount"))
    if amount is None or amount <= 0:
        return unsupported({"reason": "A positive amount is required to create an expense."}, client_state)

    expenses = list(client_state["expenses"])
    currency = normalize_currency(args.get("currency")) or client_state["defaultCurrency"]
    merchant = normalize_text(args.get("merchant")) or normalize_text(args.get("note")) or "Expense"
    note = normalize_text(args.get("note")) or merchant
    category = normalize_category(args.get("category"), client_state["categories"]) or predict_category(merchant)
    expense = {
        "id": str(uuid.uuid4()),
        "date": normalize_date(args.get("date")) or date.today().isoformat(),
        "merchant": merchant,
        "amount": round_money(amount),
        "currency": currency,
        "rate": None,
        "category": category,
        "confidence": 1.0 if args.get("category") else 0.0,
        "payment_method": "",
        "notes": note,
        "items": [],
        "source": "agent",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    expenses.append(expense)
    client_state["expenses"] = expenses

    return {
        "executedAction": {"functionName": "create_expense", "arguments": args},
        "result": {
            "ok": True,
            "message": f"Recorded {format_money(expense['amount'], currency)} for {expense['merchant']}.",
            "expense": expense,
        },
        "statePatch": build_state_patch(client_state),
    }


def delete_expense(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    expenses = list(client_state["expenses"])
    index = find_expense_index(expenses, args, client_state)

    if index < 0:
        return {
            "executedAction": {"functionName": "delete_expense", "arguments": args},
            "result": {"ok": False, "message": "I could not find a matching expense to delete."},
            "statePatch": build_state_patch(client_state),
        }

    deleted = expenses.pop(index)
    client_state["expenses"] = expenses
    return {
        "executedAction": {"functionName": "delete_expense", "arguments": {**args, "deletedExpenseId": deleted.get("id")}},
        "result": {
            "ok": True,
            "message": f"Deleted {format_money(deleted.get('amount'), deleted.get('currency'))} for {deleted.get('merchant') or deleted.get('notes')}.",
            "expense": deleted,
        },
        "statePatch": build_state_patch(client_state),
    }


def create_wishlist_item(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    item_name = normalize_text(args.get("itemName") or args.get("productQuery"))
    if not item_name:
        return unsupported({"reason": "Wishlist item name is required."}, client_state)

    wishlist = list(client_state["agent"]["wishlist"])
    item = {
        "id": f"wish_{uuid.uuid4().hex[:12]}",
        "itemName": item_name,
        "targetAmount": round_money(to_float(args.get("targetAmount"))) if to_float(args.get("targetAmount")) else None,
        "currency": normalize_currency(args.get("currency")) or client_state["defaultCurrency"],
        "priority": args.get("priority") if args.get("priority") in SUPPORTED_PRIORITIES else "medium",
        "dueDate": normalize_date(args.get("dueDate")),
        "note": normalize_text(args.get("note")),
        "status": "planned",
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    wishlist.insert(0, item)
    client_state["agent"]["wishlist"] = wishlist
    target = f" with a target of {format_money(item['targetAmount'], item['currency'])}" if item["targetAmount"] else ""

    return {
        "executedAction": {"functionName": "create_wishlist_item", "arguments": args},
        "result": {
            "ok": True,
            "message": f"Added {item_name} to the wishlist{target}.",
            "item": item,
        },
        "statePatch": build_state_patch(client_state),
    }


def get_wishlist(client_state: dict[str, Any]) -> dict[str, Any]:
    wishlist = list(client_state["agent"]["wishlist"])
    total = sum(float(item.get("targetAmount") or 0) for item in wishlist if item.get("currency") == client_state["defaultCurrency"])
    message = (
        "Your wishlist is empty."
        if not wishlist
        else f"Your wishlist has {len(wishlist)} planned item(s), with a known total target of {format_money(total, client_state['defaultCurrency'])}."
    )
    return {
        "executedAction": {"functionName": "get_wishlist", "arguments": {}},
        "result": {"ok": True, "message": message, "wishlist": wishlist, "wishlistTotal": round_money(total)},
        "statePatch": build_state_patch(client_state),
    }


def send_email_action(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    result = send_email(
        recipient_emails=normalize_email_addresses(args.get("recipientEmails") or args.get("recipientEmail")),
        subject=normalize_text(args.get("emailSubject")),
        body=normalize_text(args.get("emailBody")),
    )
    email_log = list(client_state["agent"]["emailLog"])
    email_log.insert(
        0,
        {
            "id": f"email_{uuid.uuid4().hex[:12]}",
            "to": result.get("to", []),
            "subject": args.get("emailSubject"),
            "ok": result.get("ok", False),
            "dryRun": result.get("dryRun", True),
            "message": result.get("message", ""),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        },
    )
    client_state["agent"]["emailLog"] = email_log
    return {
        "executedAction": {"functionName": "send_email", "arguments": args},
        "result": {**result, "email": email_log[0]},
        "statePatch": build_state_patch(client_state),
    }


def lookup_store_product_action(
    args: dict[str, Any],
    client_state: dict[str, Any],
    job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = lookup_store_product(args, job=job)
    return {
        "executedAction": {"functionName": "lookup_store_product", "arguments": args},
        "result": {
            "ok": result["ok"],
            "message": result.get("answer") or result.get("message", ""),
            "retailSearch": result,
            "mapPlaces": result.get("mapPlaces", []),
        },
        "statePatch": build_state_patch(client_state),
    }


def lookup_retail_offers_action(
    args: dict[str, Any],
    client_state: dict[str, Any],
    job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = lookup_retail_offers(args, job=job)
    return {
        "executedAction": {"functionName": "lookup_retail_offers", "arguments": args},
        "result": {
            "ok": result["ok"],
            "message": result.get("answer") or result.get("message", ""),
            "retailOffers": result,
            "mapPlaces": result.get("mapPlaces", []),
        },
        "statePatch": build_state_patch(client_state),
    }


def lookup_local_deals_action(
    args: dict[str, Any],
    client_state: dict[str, Any],
    job: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = lookup_local_deals(args, job=job)
    return {
        "executedAction": {"functionName": "lookup_local_deals", "arguments": args},
        "result": {
            "ok": result["ok"],
            "message": result.get("answer") or result.get("message", ""),
            "localDeals": result,
            "mapPlaces": result.get("mapPlaces", []),
        },
        "statePatch": build_state_patch(client_state),
    }


def update_profile(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    profile = dict(client_state["agent"]["profile"])
    changes: dict[str, dict[str, Any]] = {}
    field_map = {
        "name": normalize_text,
        "baseCurrency": normalize_currency,
        "currentBalance": to_float,
        "monthlyIncome": to_float,
        "monthlyBudget": to_float,
        "savingsGoalName": normalize_text,
        "savingsGoalTargetAmount": to_float,
        "savingsGoalSavedAmount": to_float,
    }

    for key, normalizer in field_map.items():
        if key not in args:
            continue
        value = normalizer(args.get(key))
        if value is None or value == "":
            continue
        if key.startswith("savingsGoal"):
            profile.setdefault("savingsGoal", {})
            nested_key = key.replace("savingsGoal", "")
            nested_key = nested_key[:1].lower() + nested_key[1:]
            before = profile["savingsGoal"].get(nested_key)
            profile["savingsGoal"][nested_key] = round_money(value) if isinstance(value, float) else value
            changes[key] = {"from": before, "to": profile["savingsGoal"][nested_key]}
        else:
            before = profile.get(key)
            profile[key] = round_money(value) if isinstance(value, float) else value
            changes[key] = {"from": before, "to": profile[key]}

    client_state["agent"]["profile"] = profile
    message = "Updated profile." if changes else "No profile fields were changed."
    return {
        "executedAction": {"functionName": "update_profile", "arguments": args},
        "result": {"ok": True, "message": message, "profile": profile, "changes": changes},
        "statePatch": build_state_patch(client_state),
    }


def get_profile(client_state: dict[str, Any]) -> dict[str, Any]:
    profile = client_state["agent"]["profile"]
    summary = build_spending_summary(client_state["expenses"], profile.get("baseCurrency") or client_state["defaultCurrency"], "current_month")
    message = (
        f"{profile.get('name')}'s monthly spending is {format_money(summary['total'], summary['currency'])}. "
        f"Monthly budget is {format_money(profile.get('monthlyBudget') or 0, summary['currency'])}."
    )
    return {
        "executedAction": {"functionName": "get_profile", "arguments": {}},
        "result": {"ok": True, "message": message, "profile": profile, "summary": summary},
        "statePatch": build_state_patch(client_state),
    }


def get_spending_summary(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    period = args.get("period") if args.get("period") in SUPPORTED_PERIODS else "current_month"
    base_currency = client_state["agent"]["profile"].get("baseCurrency") or client_state["defaultCurrency"]
    summary = build_spending_summary(client_state["expenses"], base_currency, period)
    requested_category = normalize_category(args.get("category"), client_state["categories"])
    if requested_category:
        amount = summary["byCategory"].get(requested_category, 0)
        message = f"You spent {format_money(amount, base_currency)} on {requested_category} in {period.replace('_', ' ')}."
    else:
        breakdown = ", ".join(f"{cat}: {format_money(amount, base_currency)}" for cat, amount in summary["byCategory"].items()) or "no category spending"
        message = f"Spending for {period.replace('_', ' ')} is {format_money(summary['total'], base_currency)} across {summary['count']} expense(s). {breakdown}."
    return {
        "executedAction": {"functionName": "get_spending_summary", "arguments": args},
        "result": {
            "ok": True,
            "message": message,
            "summary": {**summary, "requestedCategory": requested_category},
        },
        "statePatch": build_state_patch(client_state),
    }


def get_financial_overview(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    period = args.get("period") if args.get("period") in SUPPORTED_PERIODS else "current_month"
    profile = client_state["agent"]["profile"]
    base_currency = profile.get("baseCurrency") or client_state["defaultCurrency"]
    summary = build_spending_summary(client_state["expenses"], base_currency, period)
    wishlist = client_state["agent"]["wishlist"]
    budget_remaining = round_money((profile.get("monthlyBudget") or 0) - summary["total"])
    message = (
        f"Here is your {period.replace('_', ' ')} overview. "
        f"Spending is {format_money(summary['total'], base_currency)} across {summary['count']} expense(s). "
        f"Budget remaining is {format_money(budget_remaining, base_currency)}. "
        f"Wishlist items: {len(wishlist)}."
    )
    return {
        "executedAction": {"functionName": "get_financial_overview", "arguments": args},
        "result": {
            "ok": True,
            "message": message,
            "profile": profile,
            "summary": summary,
            "wishlist": wishlist,
        },
        "statePatch": build_state_patch(client_state),
    }


def unsupported(args: dict[str, Any], client_state: dict[str, Any]) -> dict[str, Any]:
    return {
        "executedAction": {
            "functionName": "unsupported",
            "arguments": {"reason": args.get("reason") or "The request is outside this assistant scope."},
        },
        "result": {
            "ok": False,
            "message": (
                "This assistant supports expenses, summaries, wishlist planning, email, "
                "speech, and Munich retail or local discount lookup."
            ),
        },
        "statePatch": build_state_patch(client_state),
    }


def compose_final_response_stream(
    *,
    input_text: str,
    function_call: dict[str, Any],
    execution: dict[str, Any],
    response_language: str,
    job: dict[str, Any] | None,
) -> dict[str, Any]:
    fallback = execution["result"].get("message") or "The tool completed."
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    language_label = "English" if response_language == "en" else "Simplified Chinese"

    if not api_key:
        emit_text_in_chunks(job, fallback)
        return {
            "provider": "local",
            "model": "template-fallback",
            "message": fallback,
            "warning": "GEMINI_API_KEY is not set. Used the tool message directly.",
        }

    prompt = f"""
Output language: {language_label}

User input:
{input_text}

Selected function call:
{json.dumps(function_call, ensure_ascii=False, default=str)}

Executed app result:
{truncate(json.dumps(execution["result"], ensure_ascii=False, default=str), 45000)}
""".strip()

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        model = os.environ.get("GEMINI_FINAL_RESPONSE_MODEL") or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
        config = types.GenerateContentConfig(
            temperature=0.2,
            system_instruction=build_final_response_system_instruction(response_language),
        )
        stream = client.models.generate_content_stream(model=model, contents=prompt, config=config)
        accumulated = ""
        for chunk in stream:
            token = str(getattr(chunk, "text", "") or "")
            if not token:
                continue
            accumulated += token
            realtime.emit_token(job, text=token, accumulated_text=accumulated)
            _raise_if_cancelled(job)

        message = accumulated.strip() or fallback
        if not accumulated.strip():
            emit_text_in_chunks(job, fallback)
        return {
            "provider": "gemini",
            "model": model,
            "message": message,
        }
    except Exception as exc:
        emit_text_in_chunks(job, fallback)
        return {
            "provider": "local",
            "model": "template-fallback",
            "message": fallback,
            "warning": f"Final response streaming failed: {exc}",
        }


def transcribe_audio(audio_base64: str, mime_type: str) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required for voice transcription.")
    if not audio_base64 or not mime_type:
        raise ValueError("audioBase64 and mimeType are required.")

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    audio_bytes = base64.b64decode(audio_base64)
    prompt = f"""
Transcribe this voice command for a financial app assistant.
Voice input supports English only.
Return only the spoken English words as plain text.
If the audio is not primarily English or is too unclear to transcribe confidently, return exactly {UNSUPPORTED_LANGUAGE_TOKEN}.
Do not translate non-English speech. Do not answer the command. Do not add explanations. Do not add markdown.
""".strip()
    models = unique_values([
        os.environ.get("GEMINI_TRANSCRIPTION_MODEL"),
        DEFAULT_TRANSCRIPTION_MODEL,
        FALLBACK_TRANSCRIPTION_MODEL,
    ])
    last_error: Exception | None = None

    for model in models:
        try:
            part = types.Part.from_bytes(data=audio_bytes, mime_type=mime_type)
            response = client.models.generate_content(
                model=model,
                contents=[prompt, part],
                config=types.GenerateContentConfig(temperature=0),
            )
            transcript = cleanup_transcript(str(getattr(response, "text", "") or ""))
            return {
                "provider": "gemini",
                "model": model,
                "transcript": transcript,
                "supportedLanguage": transcript.upper() != UNSUPPORTED_LANGUAGE_TOKEN,
            }
        except Exception as exc:
            last_error = exc

    raise last_error or RuntimeError("Gemini transcription failed.")


def synthesize_speech(text: str, options: dict[str, Any] | None = None) -> dict[str, Any]:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    speakable_text = str(text or "").strip()
    if not api_key:
        return {"ok": False, "warning": "GEMINI_API_KEY is required for Gemini TTS."}
    if not speakable_text:
        return {"ok": False, "warning": "No text was provided for speech synthesis."}

    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    response_language = (options or {}).get("responseLanguage")
    language_name = "English" if response_language == "en" else "Simplified Chinese"
    prompt = f"Read this {language_name} finance assistant response clearly, naturally, and at a steady pace. Say exactly this text: {speakable_text}"
    models = unique_values([os.environ.get("GEMINI_TTS_MODEL"), DEFAULT_TTS_MODEL, FALLBACK_TTS_MODEL])
    voice_name = os.environ.get("GEMINI_TTS_VOICE") or DEFAULT_TTS_VOICE
    last_error: Exception | None = None

    for model in models:
        try:
            config = types.GenerateContentConfig(
                response_modalities=["AUDIO"],
                speech_config=types.SpeechConfig(
                    voice_config=types.VoiceConfig(
                        prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice_name)
                    )
                ),
            )
            response = client.models.generate_content(model=model, contents=prompt, config=config)
            inline = extract_inline_audio(response)
            if not inline:
                last_error = RuntimeError("Gemini TTS returned no audio data.")
                continue
            raw_audio = base64.b64decode(inline["data"])
            mime_type = inline.get("mimeType") or "audio/pcm"
            wav_audio = raw_audio if "wav" in mime_type else create_wav_buffer(raw_audio)
            return {
                "ok": True,
                "provider": "gemini",
                "model": model,
                "voiceName": voice_name,
                "mimeType": "audio/wav",
                "audioBase64": base64.b64encode(wav_audio).decode("ascii"),
            }
        except Exception as exc:
            last_error = exc

    return {
        "ok": False,
        "warning": f"Gemini TTS failed: {last_error or 'unknown error'}",
        "model": models[0] if models else None,
        "voiceName": voice_name,
    }


def maybe_start_discount_lookup_job(
    *,
    client_id: str | None,
    execution: dict[str, Any],
    response_language: str,
) -> dict[str, Any] | None:
    candidate = build_discount_candidate(execution)
    if not candidate or not client_id:
        return None

    job = realtime.create_job(
        client_id=client_id,
        job_type="discount_lookup",
        label=f"Discount check: {candidate['productQuery']}",
        metadata={**candidate, "responseLanguage": response_language},
    )
    if not job:
        return None

    thread = threading.Thread(
        target=_run_discount_lookup_job,
        args=(job, candidate, response_language),
        name=f"discount-{job['id']}",
        daemon=True,
    )
    thread.start()
    return {"jobId": job["id"], **candidate}


def lookup_store_product(args: dict[str, Any], job: dict[str, Any] | None = None) -> dict[str, Any]:
    product_query = normalize_text(args.get("productQuery")) or "product"
    location = normalize_text(args.get("location")) or DEFAULT_LOCATION
    retailers = normalize_retailers(args.get("retailers"), product_query)
    retailer_names = ", ".join(RETAILERS[r]["name"] for r in retailers if r in RETAILERS)
    places = discover_places(f"{product_query} {retailer_names or 'stores'} {location}")
    emit_places_progress(job, product_query=product_query, map_places=places)
    sources = collect_retail_sources(retailers)
    official_pages = fetch_source_pages(sources[:8])
    prompt = f"""
Research current product price, stock, availability, or useful official evidence.
Product: {product_query}
Retailers: {retailer_names or 'supported Munich retailers'}
Location: {location}
Official/source pages already checked:
{json.dumps(official_pages, ensure_ascii=False)}
Nearby mapped stores:
{json.dumps(places[:8], ensure_ascii=False)}

Use Google Search grounding if available. Separate confirmed physical-store availability from online-only or unconfirmed evidence. Include source URLs.
""".strip()
    answer = run_grounded_research(prompt, sources)
    return {
        "ok": bool(answer),
        "request": {"productQuery": product_query, "retailers": retailers, "location": location},
        "answer": answer or "No grounded product lookup result was available.",
        "message": answer or "No grounded product lookup result was available.",
        "sources": sources,
        "checkedPages": official_pages,
        "mapPlaces": places,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
    }


def lookup_retail_offers(args: dict[str, Any], job: dict[str, Any] | None = None) -> dict[str, Any]:
    location = normalize_text(args.get("location")) or DEFAULT_LOCATION
    retailers = normalize_retailers(args.get("retailers"), "")
    if not retailers:
        retailers = ["edeka"]
    retailer_names = ", ".join(RETAILERS[r]["name"] for r in retailers if r in RETAILERS)
    places = discover_places(f"{retailer_names} Angebote {location}")
    emit_places_progress(job, product_query=retailer_names or "Retail offers", map_places=places)
    sources = collect_retail_sources(retailers, offers_only=True)
    pages = fetch_source_pages(sources[:10])
    prompt = f"""
Look up current or recent retailer discounts, weekly offers, Angebote, promotions, or prospect pages.
Retailers: {retailer_names}
Location: {location}
Period: {args.get('period') or 'current_week'}
Official/source pages already checked:
{json.dumps(pages, ensure_ascii=False)}
Nearby mapped stores:
{json.dumps(places[:8], ensure_ascii=False)}

Explain confirmed offer items with prices separately from pages that were found but not parseable. Include source URLs.
""".strip()
    answer = run_grounded_research(prompt, sources)
    return {
        "ok": bool(answer or pages or places),
        "request": {"retailers": retailers, "location": location, "period": args.get("period") or "current_week"},
        "answer": answer or "No current retailer offer could be confirmed from available sources.",
        "message": answer or "No current retailer offer could be confirmed from available sources.",
        "sources": sources,
        "officialOfferPages": pages,
        "mapPlaces": places,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
    }


def lookup_local_deals(args: dict[str, Any], job: dict[str, Any] | None = None) -> dict[str, Any]:
    merchant_query = normalize_text(args.get("merchantQuery") or args.get("merchant") or args.get("storeName")) or "local merchant"
    merchant = find_known_local_merchant(merchant_query)
    display_name = merchant["name"] if merchant else merchant_query
    product_query = normalize_text(args.get("productQuery"))
    location = normalize_text(args.get("location")) or DEFAULT_LOCATION
    places = discover_places(f"{display_name} {location}")
    emit_places_progress(job, product_query=display_name, map_places=places)
    sources = list(merchant.get("dealPages", []) if merchant else [])
    pages = fetch_source_pages(sources[:8])
    prompt = f"""
Look up current or recent discounts, coupons, app offers, meal deals, Gutscheine, Aktionen, or promotions.
Merchant: {display_name}
Product/context: {product_query or 'general deal lookup'}
Location: {location}
Period: {args.get('period') or 'current_week'}
Official/source pages already checked:
{json.dumps(pages, ensure_ascii=False)}
Nearby mapped stores:
{json.dumps(places[:8], ensure_ascii=False)}

Explain whether current food/restaurant/app discounts were confirmed, only found as official app/deal pages, or not confirmed. Include source URLs.
""".strip()
    answer = run_grounded_research(prompt, sources)
    return {
        "ok": bool(answer or pages or places),
        "request": {"merchantQuery": display_name, "productQuery": product_query, "location": location},
        "answer": answer or "No current local merchant deal could be confirmed from available sources.",
        "message": answer or "No current local merchant deal could be confirmed from available sources.",
        "sources": sources,
        "officialDealPages": pages,
        "mapPlaces": places,
        "retrievedAt": datetime.now(timezone.utc).isoformat(),
    }


def _run_discount_lookup_job(job: dict[str, Any], candidate: dict[str, Any], response_language: str) -> None:
    try:
        realtime.emit_progress(
            job,
            stage="discount_job_started",
            message=f"Checking Munich discount information for {candidate['productQuery']}.",
            data=candidate,
        )
        _raise_if_cancelled(job)

        if candidate.get("lookupMode") == "local_deals":
            function_call = {
                "name": "lookup_local_deals",
                "args": {
                    "merchantQuery": candidate.get("merchantQuery") or candidate["productQuery"],
                    "productQuery": candidate["productQuery"],
                    "category": candidate.get("category") or "Food & Beverage",
                    "location": DEFAULT_LOCATION,
                    "period": "current_week",
                    "date": date.today().isoformat(),
                },
            }
            lookup_result = lookup_local_deals(function_call["args"])
            result_key = "localDeals"
        else:
            function_call = {
                "name": "lookup_store_product",
                "args": {
                    "productQuery": candidate["productQuery"],
                    "retailers": candidate.get("retailers"),
                    "location": DEFAULT_LOCATION,
                    "lookupType": "price_and_availability",
                    "date": date.today().isoformat(),
                },
            }
            lookup_result = lookup_store_product(function_call["args"])
            result_key = "retailSearch"

        realtime.emit_progress(
            job,
            stage="discount_summary_started",
            message="Summarizing discount check result.",
        )
        final = compose_final_response_stream(
            input_text=f"Check current discount evidence for {candidate['productQuery']} in Munich. Explain uncertainty clearly.",
            function_call=function_call,
            execution={
                "result": {
                    "ok": lookup_result.get("ok"),
                    "message": lookup_result.get("answer") or lookup_result.get("message"),
                    result_key: lookup_result,
                    "mapPlaces": lookup_result.get("mapPlaces", []),
                }
            },
            response_language=response_language,
            job=job,
        )
        _raise_if_cancelled(job)
        discount_insight = {
            "productQuery": candidate["productQuery"],
            "sourceAction": candidate.get("sourceAction"),
            "sourceId": candidate.get("sourceId"),
            "sourceLabel": candidate.get("sourceLabel"),
            "message": final["message"],
            result_key: lookup_result,
            "mapPlaces": lookup_result.get("mapPlaces", []),
            "sources": lookup_result.get("sources", []),
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
        realtime.emit_progress(
            job,
            stage="discount_job_done",
            message=f"Discount check completed for {candidate['productQuery']}.",
            data={"discountInsight": discount_insight},
        )
        realtime.complete_job(job, {"discountInsight": discount_insight})
    except Exception as exc:
        realtime.fail_job(job, exc)


def normalize_client_state(raw: dict[str, Any]) -> dict[str, Any]:
    default_currency = normalize_currency(raw.get("defaultCurrency")) or "EUR"
    categories = raw.get("categories") if isinstance(raw.get("categories"), list) else DEFAULT_CATEGORIES
    categories = [str(cat) for cat in categories if str(cat).strip()] or DEFAULT_CATEGORIES
    agent = raw.get("agent") if isinstance(raw.get("agent"), dict) else {}
    profile = agent.get("profile") if isinstance(agent.get("profile"), dict) else {}
    wishlist = agent.get("wishlist") if isinstance(agent.get("wishlist"), list) else []
    email_log = agent.get("emailLog") if isinstance(agent.get("emailLog"), list) else []

    return {
        "expenses": raw.get("expenses") if isinstance(raw.get("expenses"), list) else [],
        "defaultCurrency": default_currency,
        "categories": categories,
        "agent": {
            "profile": {
                "id": profile.get("id") or "flo_agent_user",
                "name": profile.get("name") or "Flo User",
                "baseCurrency": normalize_currency(profile.get("baseCurrency")) or default_currency,
                "currentBalance": to_float(profile.get("currentBalance")) or 0,
                "monthlyIncome": to_float(profile.get("monthlyIncome")) or 0,
                "monthlyBudget": to_float(profile.get("monthlyBudget")) or 0,
                "savingsGoal": profile.get("savingsGoal") if isinstance(profile.get("savingsGoal"), dict) else {
                    "name": "Savings goal",
                    "targetAmount": 0,
                    "savedAmount": 0,
                },
            },
            "wishlist": wishlist,
            "emailLog": email_log,
        },
    }


def build_state_patch(client_state: dict[str, Any]) -> dict[str, Any]:
    return {
        "expenses": client_state["expenses"],
        "agent": client_state["agent"],
    }


def build_spending_summary(expenses: list[dict[str, Any]], base_currency: str, period: str) -> dict[str, Any]:
    filtered = filter_expenses_by_period(expenses, period)
    by_category: dict[str, float] = {}
    total = 0.0

    for expense in filtered:
        amount = convert_to_base(expense, base_currency)
        total += amount
        category = str(expense.get("category") or "Others")
        by_category[category] = by_category.get(category, 0) + amount

    return {
        "period": period,
        "currency": base_currency,
        "total": round_money(total),
        "count": len(filtered),
        "byCategory": dict(sorted(((cat, round_money(value)) for cat, value in by_category.items()), key=lambda item: item[1], reverse=True)),
    }


def filter_expenses_by_period(expenses: list[dict[str, Any]], period: str) -> list[dict[str, Any]]:
    today = date.today()
    if period == "all_time":
        return expenses
    if period == "today":
        return [expense for expense in expenses if expense.get("date") == today.isoformat()]
    if period == "current_week":
        week_start = today - timedelta(days=today.weekday())
        return [expense for expense in expenses if parse_date(expense.get("date")) and week_start <= parse_date(expense.get("date")) <= today]
    return [
        expense
        for expense in expenses
        if parse_date(expense.get("date"))
        and parse_date(expense.get("date")).year == today.year
        and parse_date(expense.get("date")).month == today.month
    ]


def build_system_instruction(categories: list[str]) -> str:
    today = date.today().isoformat()
    return f"""
You route each Flo financial assistant request by calling exactly one registered function.
- Current date is {today}.
- The app stores expenses in the browser; actions must be concrete and reversible through returned state patches.
- Use EUR when the user says euro, euros, €, 欧, or 欧元. Use USD for dollar, dollars, or $.
- If the user says 块 or 块钱 without RMB/人民币/CNY, default to EUR for this Munich-based app.
- Use one of these expense categories when possible: {", ".join(categories)}.
- If the user records spending, call create_expense.
- If the user asks for summaries, profile, wishlist, or deleting an expense, call the matching finance function.
- If the user asks to send email, extract every requested recipient email, a short subject, and the plain-text body.
- If a request asks to look up information and then email the final answer, first call the information lookup function; post-response email is handled separately.
- For retailer discounts, offers, Angebote, Prospekt, 打折, 优惠, or product price/stock in Munich, use lookup_retail_offers, lookup_local_deals, or lookup_store_product.
- For named restaurant, cafe, food chain, or local merchant discounts, call lookup_local_deals.
- For current product price, stock, or availability at Munich retailers, call lookup_store_product.
- For consumer electronics, default unspecified retailers to mediamarkt and saturn.
""".strip()


def build_final_response_system_instruction(response_language: str) -> str:
    language = "English" if response_language == "en" else "Simplified Chinese"
    return f"""
You write the final user-facing response after a registered app function has executed.
Respond in {language}.
Use only the tool result and source URLs provided by the app. Do not invent prices, stock, stores, or actions.
Use concise Markdown. For retail/deal lookup, distinguish confirmed evidence from uncertainty and include concise source links when available.
For finance actions, summarize the completed action directly.
""".strip()


def build_function_declarations(categories: list[str]) -> list[dict[str, Any]]:
    category_values = [*dict.fromkeys([*categories, *DEFAULT_CATEGORIES])]
    return [
        function_decl(
            "create_expense",
            "Record a user expense or spending event.",
            {
                "merchant": string_schema("Merchant or store name."),
                "amount": number_schema("Positive expense amount."),
                "currency": enum_schema(SUPPORTED_CURRENCIES, "ISO currency code."),
                "category": enum_schema(category_values, "Expense category."),
                "note": string_schema("Short note or purchased item."),
                "date": string_schema("ISO date YYYY-MM-DD if mentioned."),
            },
            ["amount"],
        ),
        function_decl(
            "delete_expense",
            "Delete an existing expense by id or natural language selectors.",
            {
                "expenseId": string_schema("Expense id."),
                "amount": number_schema("Expense amount selector."),
                "currency": enum_schema(SUPPORTED_CURRENCIES, "Currency selector."),
                "category": enum_schema(category_values, "Category selector."),
                "note": string_schema("Merchant or note selector."),
            },
        ),
        function_decl(
            "create_wishlist_item",
            "Create a purchase plan or wishlist item.",
            {
                "itemName": string_schema("Wishlist item name."),
                "targetAmount": number_schema("Target amount when present."),
                "currency": enum_schema(SUPPORTED_CURRENCIES, "ISO currency code."),
                "priority": enum_schema(SUPPORTED_PRIORITIES, "Wishlist priority."),
                "dueDate": string_schema("ISO date YYYY-MM-DD."),
                "note": string_schema("Short note."),
            },
            ["itemName"],
        ),
        function_decl("get_wishlist", "View or calculate planned wishlist items.", {}),
        function_decl(
            "send_email",
            "Send a plain-text email message through configured Gmail SMTP.",
            {
                "recipientEmail": string_schema("Recipient email address."),
                "recipientEmails": array_schema(string_schema("Recipient email address."), "Recipient emails."),
                "emailSubject": string_schema("Short subject line."),
                "emailBody": string_schema("Plain-text email body."),
            },
            ["emailSubject", "emailBody"],
        ),
        function_decl(
            "lookup_store_product",
            "Look up current product price, stock, availability, or product information for Munich retailers.",
            {
                "productQuery": string_schema("Product or product category to look up."),
                "retailers": array_schema(enum_schema(SUPPORTED_RETAILER_IDS, "Supported retailer id."), "Retailer ids."),
                "location": string_schema("City or area. Default Munich, Germany."),
                "lookupType": enum_schema(["price", "availability", "price_and_availability"], "Lookup type."),
                "date": string_schema("ISO date YYYY-MM-DD."),
            },
            ["productQuery"],
        ),
        function_decl(
            "lookup_retail_offers",
            "Look up current retailer discounts, weekly offers, Angebote, promotions, or prospect pages.",
            {
                "retailers": array_schema(enum_schema(SUPPORTED_RETAILER_IDS, "Supported retailer id."), "Retailer ids."),
                "location": string_schema("City or area. Default Munich, Germany."),
                "period": enum_schema(SUPPORTED_PERIODS, "Offer period."),
                "date": string_schema("ISO date YYYY-MM-DD."),
            },
            ["retailers"],
        ),
        function_decl(
            "lookup_local_deals",
            "Look up current discounts, coupons, app offers, meal deals, or promotions for a named merchant.",
            {
                "merchantQuery": string_schema("Named merchant, restaurant, cafe, or local shop."),
                "productQuery": string_schema("Optional product or meal context."),
                "category": enum_schema(category_values, "Category context."),
                "location": string_schema("City or area. Default Munich, Germany."),
                "period": enum_schema(SUPPORTED_PERIODS, "Offer period."),
                "date": string_schema("ISO date YYYY-MM-DD."),
            },
            ["merchantQuery"],
        ),
        function_decl(
            "update_profile",
            "Update personal finance profile fields.",
            {
                "name": string_schema("User display name."),
                "baseCurrency": enum_schema(SUPPORTED_CURRENCIES, "Default currency."),
                "currentBalance": number_schema("Current balance."),
                "monthlyIncome": number_schema("Monthly income."),
                "monthlyBudget": number_schema("Monthly budget."),
                "savingsGoalName": string_schema("Savings goal name."),
                "savingsGoalTargetAmount": number_schema("Savings goal target."),
                "savingsGoalSavedAmount": number_schema("Savings goal saved amount."),
            },
        ),
        function_decl("get_profile", "Show profile, balance, budget, or account info.", {}),
        function_decl(
            "get_spending_summary",
            "Show spending totals, category breakdowns, or period spending.",
            {
                "period": enum_schema(SUPPORTED_PERIODS, "Summary period."),
                "category": enum_schema(category_values, "Specific category."),
            },
        ),
        function_decl(
            "get_financial_overview",
            "Show an overall financial recap with profile, spending, and wishlist.",
            {"period": enum_schema(SUPPORTED_PERIODS, "Overview period.")},
        ),
        function_decl(
            "unsupported",
            "Use when the request is outside scope, ambiguous, or missing required fields.",
            {"reason": string_schema("Short reason.")},
            ["reason"],
        ),
    ]


def function_decl(name: str, description: str, properties: dict[str, Any], required: list[str] | None = None) -> dict[str, Any]:
    return {
        "name": name,
        "description": description,
        "parameters": {
            "type": "object",
            "properties": properties,
            "required": required or [],
        },
    }


def string_schema(description: str) -> dict[str, Any]:
    return {"type": "string", "description": description}


def number_schema(description: str) -> dict[str, Any]:
    return {"type": "number", "description": description}


def enum_schema(values: list[str], description: str) -> dict[str, Any]:
    return {"type": "string", "enum": values, "description": description}


def array_schema(items: dict[str, Any], description: str) -> dict[str, Any]:
    return {"type": "array", "items": items, "description": description}


def parse_with_rules(input_text: str, client_state: dict[str, Any]) -> dict[str, Any]:
    text = input_text.strip()
    lower = text.lower()
    amount = extract_amount(text)
    currency = extract_currency(text) or client_state["defaultCurrency"]

    if looks_like_deal_request(text):
        merchant = find_known_local_merchant(text)
        if merchant or looks_like_local_merchant_request(text):
            return {
                "name": "lookup_local_deals",
                "args": {
                    "merchantQuery": merchant["name"] if merchant else extract_merchant_query(text),
                    "productQuery": extract_product_query(text),
                    "category": "Food & Beverage",
                    "location": extract_location(text),
                    "period": "current_week",
                },
            }
        if looks_like_offer_request(text):
            return {
                "name": "lookup_retail_offers",
                "args": {
                    "retailers": find_retailer_ids(text) or ["edeka"],
                    "location": extract_location(text),
                    "period": "current_week",
                },
            }
        return {
            "name": "lookup_store_product",
            "args": {
                "productQuery": extract_product_query(text),
                "retailers": find_retailer_ids(text),
                "location": extract_location(text),
                "lookupType": "price_and_availability",
            },
        }

    if looks_like_email_request(lower):
        return {
            "name": "send_email",
            "args": {
                "recipientEmails": resolve_requested_recipient_emails(text),
                "emailSubject": extract_email_subject(text),
                "emailBody": extract_email_body(text),
            },
        }

    if looks_like_wishlist_request(lower):
        if looks_like_list_request(lower) or "多少" in text or "how much" in lower:
            return {"name": "get_wishlist", "args": {}}
        return {
            "name": "create_wishlist_item",
            "args": {
                "itemName": extract_wishlist_item(text),
                "targetAmount": amount,
                "currency": currency,
                "priority": "medium",
            },
        }

    if looks_like_summary_request(lower):
        return {"name": "get_spending_summary", "args": {"period": extract_period(lower), "category": extract_category(text, client_state["categories"])}}

    if looks_like_overview_request(lower):
        return {"name": "get_financial_overview", "args": {"period": extract_period(lower)}}

    if looks_like_profile_update_request(lower):
        return {"name": "update_profile", "args": extract_profile_update_args(text)}

    if looks_like_profile_request(lower):
        return {"name": "get_profile", "args": {}}

    if looks_like_delete_expense_request(lower):
        return {
            "name": "delete_expense",
            "args": {
                "amount": amount,
                "currency": currency,
                "category": extract_category(text, client_state["categories"]),
                "note": extract_note(text),
            },
        }

    if looks_like_expense_request(lower) or amount:
        return {
            "name": "create_expense",
            "args": {
                "merchant": extract_merchant_query(text),
                "amount": amount,
                "currency": currency,
                "category": extract_category(text, client_state["categories"]),
                "note": extract_note(text),
                "date": extract_date(text),
            },
        }

    return {"name": "unsupported", "args": {"reason": "Could not map the request to a supported action."}}


def normalize_function_call(raw: dict[str, Any], categories: list[str]) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    name = source.get("name") if source.get("name") in SUPPORTED_FUNCTIONS else "unsupported"
    args = source.get("args") if isinstance(source.get("args"), dict) else {}
    normalized: dict[str, Any] = {}

    for key, value in args.items():
        if value in ("", None, [], {}):
            continue
        normalized[key] = value

    if "amount" in normalized:
        normalized["amount"] = to_float(normalized["amount"])
    if "targetAmount" in normalized:
        normalized["targetAmount"] = to_float(normalized["targetAmount"])
    if "currency" in normalized:
        normalized["currency"] = normalize_currency(normalized["currency"])
    if "baseCurrency" in normalized:
        normalized["baseCurrency"] = normalize_currency(normalized["baseCurrency"])
    if "category" in normalized:
        normalized["category"] = normalize_category(normalized["category"], categories)
    if "period" in normalized and normalized["period"] not in SUPPORTED_PERIODS:
        normalized["period"] = "current_month"
    if "date" in normalized:
        normalized["date"] = normalize_date(normalized["date"])
    if "dueDate" in normalized:
        normalized["dueDate"] = normalize_date(normalized["dueDate"])
    if "retailers" in normalized:
        normalized["retailers"] = normalize_retailers(normalized["retailers"], normalized.get("productQuery"))
    if "recipientEmails" in normalized:
        normalized["recipientEmails"] = normalize_email_addresses(normalized["recipientEmails"])

    return {"name": name, "args": {key: value for key, value in normalized.items() if value not in (None, "", [])}}


def extract_function_call(response: Any) -> dict[str, Any]:
    calls = getattr(response, "function_calls", None) or getattr(response, "functionCalls", None)
    if calls:
        call = calls[0]
        return {"name": getattr(call, "name", None), "args": dict(getattr(call, "args", {}) or {})}

    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", []) or []:
            function_call = getattr(part, "function_call", None) or getattr(part, "functionCall", None)
            if function_call:
                return {
                    "name": getattr(function_call, "name", None),
                    "args": dict(getattr(function_call, "args", {}) or {}),
                }

    raise RuntimeError("Gemini did not return a function call.")


def maybe_send_final_answer_by_email(
    *,
    input_text: str,
    final_message: str,
    client_state: dict[str, Any],
) -> dict[str, Any] | None:
    lower = input_text.lower()
    if not looks_like_send_final_answer_email_request(lower):
        return None
    recipients = resolve_requested_recipient_emails(input_text)
    if not recipients:
        return None
    return send_email_action(
        {
            "recipientEmails": recipients,
            "emailSubject": "Financial assistant result",
            "emailBody": final_message,
        },
        client_state,
    )


def send_email(recipient_emails: list[str], subject: str, body: str) -> dict[str, Any]:
    if not recipient_emails:
        return {"ok": False, "message": "Email sending failed: no recipient email was provided.", "to": []}
    if not subject or not body:
        return {"ok": False, "message": "Email sending failed: subject and body are required.", "to": recipient_emails}

    dry_run = str(os.environ.get("EMAIL_DRY_RUN", "true")).lower() != "false"
    if dry_run:
        return {
            "ok": True,
            "dryRun": True,
            "to": recipient_emails,
            "message": f"Prepared email to {', '.join(recipient_emails)}. Dry run is enabled, so no email was sent.",
        }

    user = os.environ.get("GMAIL_USER")
    password = os.environ.get("GMAIL_APP_PASSWORD")
    sender = os.environ.get("EMAIL_FROM") or user
    if not user or not password:
        return {"ok": False, "dryRun": False, "to": recipient_emails, "message": "Email sending failed: Gmail credentials are not configured."}

    msg = EmailMessage()
    msg["From"] = sender
    msg["To"] = ", ".join(recipient_emails)
    msg["Subject"] = subject
    msg.set_content(body)

    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context()) as smtp:
        smtp.login(user, password)
        smtp.send_message(msg)

    return {"ok": True, "dryRun": False, "to": recipient_emails, "message": f"Sent email to {', '.join(recipient_emails)}."}


def run_grounded_research(prompt: str, sources: list[str]) -> str:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    source_text = "\n".join(f"- {source}" for source in sources[:12])
    if source_text:
        prompt = f"{prompt}\n\nKnown source URLs:\n{source_text}"
    if not api_key:
        return (
            "Grounded web research is unavailable because GEMINI_API_KEY is not configured. "
            f"Checked source candidates: {', '.join(sources[:5]) or 'none'}."
        )

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)
        model = os.environ.get("RETAIL_SEARCH_MODEL") or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
        try:
            config = types.GenerateContentConfig(
                temperature=0.2,
                tools=[types.Tool(google_search=types.GoogleSearch())],
            )
            response = client.models.generate_content(model=model, contents=prompt, config=config)
        except Exception:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(temperature=0.2),
            )
        return str(getattr(response, "text", "") or "").strip()
    except Exception as exc:
        return f"Retail/deal lookup failed during Gemini research: {exc}"


def discover_places(query: str) -> list[dict[str, Any]]:
    api_key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not api_key:
        return []
    url = "https://places.googleapis.com/v1/places:searchText"
    payload = {
        "textQuery": query,
        "languageCode": "de",
        "regionCode": "DE",
        "locationBias": {
            "circle": {
                "center": {"latitude": 48.137154, "longitude": 11.576124},
                "radius": 20000,
            }
        },
    }
    try:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": api_key,
                "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri,places.websiteUri,places.nationalPhoneNumber,places.businessStatus",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception:
        return []

    places = []
    for place in data.get("places", [])[:20]:
        location = place.get("location") or {}
        places.append(
            {
                "placeId": place.get("id"),
                "name": (place.get("displayName") or {}).get("text"),
                "address": place.get("formattedAddress"),
                "latitude": location.get("latitude"),
                "longitude": location.get("longitude"),
                "googleMapsUri": place.get("googleMapsUri"),
                "websiteUri": place.get("websiteUri"),
                "phone": place.get("nationalPhoneNumber"),
                "businessStatus": place.get("businessStatus"),
                "source": "google_places",
            }
        )
    return places


def emit_places_progress(
    job: dict[str, Any] | None,
    *,
    product_query: str,
    map_places: list[dict[str, Any]],
) -> None:
    if not job:
        return

    realtime.emit_progress(
        job,
        stage="places_search_done",
        message=(
            f"Found {len(map_places)} nearby place candidate(s)."
            if map_places
            else "Places discovery completed with no mapped places."
        ),
        data={
            "productQuery": product_query,
            "mapPlaces": map_places,
        },
    )


def collect_retail_sources(retailers: list[str], offers_only: bool = False) -> list[str]:
    expanded = []
    for retailer_id in retailers:
        if retailer_id == "all_supported":
            expanded.extend([key for key in RETAILERS if key != "asian_grocery"])
        elif retailer_id in RETAILERS:
            expanded.append(retailer_id)
    if not expanded:
        expanded = ["edeka"]

    sources: list[str] = []
    for retailer_id in dict.fromkeys(expanded):
        config = RETAILERS[retailer_id]
        sources.extend(config.get("offerPages", []))
        if not offers_only:
            sources.extend(f"https://www.{domain}" for domain in config.get("domains", []))
    return [*dict.fromkeys(sources)]


def fetch_source_pages(urls: list[str]) -> list[dict[str, Any]]:
    pages = []
    for url in urls:
        pages.append(fetch_source_page(url))
    return pages


def fetch_source_page(url: str) -> dict[str, Any]:
    try:
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 Flo-Finance-Agent/1.0",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
            },
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            raw = response.read(400000).decode("utf-8", errors="ignore")
            status = response.status
    except Exception as exc:
        return {"url": url, "ok": False, "error": str(exc), "snippets": []}

    title = extract_title(raw)
    snippets = extract_offer_snippets(raw)
    return {"url": url, "ok": 200 <= status < 400, "status": status, "title": title, "snippets": snippets[:10]}


def extract_title(html: str) -> str | None:
    match = re.search(r"<title[^>]*>(.*?)</title>", html, flags=re.I | re.S)
    if not match:
        return None
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", match.group(1))).strip()[:180]


def extract_offer_snippets(html: str) -> list[str]:
    text = re.sub(r"<script\b.*?</script>", " ", html, flags=re.I | re.S)
    text = re.sub(r"<style\b.*?</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<[^>]+>", "\n", text)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    seen = set()
    snippets = []
    for line in lines:
        if len(line) < 18 or len(line) > 220:
            continue
        if not re.search(r"(€|%|angebot|aktion|coupon|gutschein|deal|rabatt|spar|sale)", line, flags=re.I):
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        snippets.append(line)
        if len(snippets) >= 20:
            break
    return snippets


def build_discount_candidate(execution: dict[str, Any]) -> dict[str, Any] | None:
    action = execution.get("executedAction", {}).get("functionName")
    result = execution.get("result", {})

    if action == "create_wishlist_item":
        item = result.get("item") or {}
        product = normalize_text(item.get("itemName"))
        if product:
            return {
                "sourceAction": "create_wishlist_item",
                "sourceId": item.get("id"),
                "sourceLabel": item.get("itemName"),
                "productQuery": product,
                "retailers": infer_retailers_for_product(product),
                "location": DEFAULT_LOCATION,
                "trigger": "post_wishlist_create",
                "lookupMode": "retail_product",
            }

    if action == "create_expense":
        expense = result.get("expense") or {}
        product = normalize_text(expense.get("notes") or expense.get("merchant"))
        if product and product.lower() not in {"expense", "支出", "消费"}:
            category = expense.get("category") or "Others"
            local = category == "Food & Beverage" or find_known_local_merchant(product)
            return {
                "sourceAction": "create_expense",
                "sourceId": expense.get("id"),
                "sourceLabel": expense.get("merchant"),
                "productQuery": product,
                "merchantQuery": expense.get("merchant"),
                "category": category,
                "retailers": None if local else infer_retailers_for_product(product),
                "location": DEFAULT_LOCATION,
                "trigger": "post_expense_create",
                "lookupMode": "local_deals" if local else "retail_product",
            }

    return None


def infer_retailers_for_product(product_query: str) -> list[str] | None:
    if re.search(r"(ipad|iphone|apple\s*pencil|macbook|laptop|tablet|smartphone|headphone|airpods|camera|monitor|tv|电子|电脑|平板|手机|耳机|相机|显示器|电视)", product_query, re.I):
        return ["mediamarkt", "saturn"]
    return None


def find_expense_index(expenses: list[dict[str, Any]], args: dict[str, Any], client_state: dict[str, Any]) -> int:
    expense_id = normalize_text(args.get("expenseId"))
    if expense_id:
        for index, expense in enumerate(expenses):
            if expense.get("id") == expense_id:
                return index

    target_amount = to_float(args.get("amount"))
    target_category = normalize_category(args.get("category"), client_state["categories"])
    target_note = normalize_text(args.get("note")).lower()

    candidates = list(enumerate(expenses))
    if target_amount is not None:
        candidates = [
            (index, expense)
            for index, expense in candidates
            if abs(float(expense.get("amount") or 0) - target_amount) < 0.01
        ]
    if target_category:
        candidates = [(index, expense) for index, expense in candidates if expense.get("category") == target_category]
    if target_note:
        candidates = [
            (index, expense)
            for index, expense in candidates
            if target_note in str(expense.get("merchant") or "").lower()
            or target_note in str(expense.get("notes") or "").lower()
        ]

    return candidates[-1][0] if candidates else -1


def predict_category(merchant: str) -> str:
    try:
        import classifier

        prediction, _confidence, _embedding, _top3 = classifier.do_classify(merchant)
        return prediction or "Others"
    except Exception:
        return "Others"


def convert_to_base(expense: dict[str, Any], base_currency: str) -> float:
    amount = float(expense.get("amount") or 0)
    currency = normalize_currency(expense.get("currency")) or base_currency
    if currency == base_currency:
        return amount
    rate = to_float(expense.get("rate"))
    return amount * rate if rate and rate > 0 else amount


def extract_amount(text: str) -> float | None:
    patterns = [
        r"([0-9]+(?:[.,][0-9]+)?)\s*(?:euros|euro|eur|€|dollars|dollar|usd|\$|cny|rmb|块钱|元|块|欧元|欧)",
        r"(?:euros|euro|eur|€|dollars|dollar|usd|\$|cny|rmb|块钱|元|块|欧元|欧)\s*([0-9]+(?:[.,][0-9]+)?)",
        r"([0-9]+(?:[.,][0-9]+)?)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.I)
        if match:
            return to_float(match.group(1).replace(",", "."))
    return None


def extract_currency(text: str) -> str | None:
    lower = text.lower()
    if re.search(r"(usd|dollar|dollars|\$)", lower):
        return "USD"
    if re.search(r"(gbp|pound|£)", lower):
        return "GBP"
    if re.search(r"(cny|rmb|人民币|元)", lower):
        return "CNY"
    if re.search(r"(eur|euro|euros|€|欧|欧元|块|块钱)", lower):
        return "EUR"
    return None


def extract_category(text: str, categories: list[str]) -> str | None:
    lower = text.lower()
    for category in categories:
        if category.lower() in lower:
            return category
    for key, value in CATEGORY_ALIASES.items():
        if key in lower or key in text:
            return normalize_category(value, categories)
    return None


def extract_period(lower: str) -> str:
    if "today" in lower or "今天" in lower:
        return "today"
    if "week" in lower or "本周" in lower or "这周" in lower:
        return "current_week"
    if "all" in lower or "全部" in lower or "总共" in lower:
        return "all_time"
    return "current_month"


def extract_date(text: str) -> str | None:
    match = re.search(r"\b(20\d{2}-\d{1,2}-\d{1,2})\b", text)
    if match:
        return normalize_date(match.group(1))
    if "yesterday" in text.lower() or "昨天" in text:
        return (date.today() - timedelta(days=1)).isoformat()
    if "today" in text.lower() or "今天" in text:
        return date.today().isoformat()
    return None


def extract_note(text: str) -> str:
    cleaned = re.sub(r"\b(record|add|spent|paid|expense|delete|remove|帮我|记录|一笔|支出|消费|花了|删除)\b", " ", text, flags=re.I)
    cleaned = re.sub(r"[0-9]+(?:[.,][0-9]+)?\s*(?:euros|euro|eur|€|dollars|dollar|usd|\$|cny|rmb|块钱|元|块|欧元|欧)?", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\b(a|an|the|for|on)\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,，。.")
    return cleaned[:120] or "expense"


def extract_product_query(text: str) -> str:
    cleaned = re.sub(r"(discounts|discount|deals|deal|coupons|coupon|offers|offer|angebote|angebot|price|stock|availability|available|lookup|look up|check|current|today|打折|优惠|折扣|价格|库存|查询|查一下|有没有)", " ", text, flags=re.I)
    for retailer in RETAILERS.values():
        cleaned = re.sub(re.escape(retailer["name"]), " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\b(in|at|near|munich|germany|慕尼黑|德国)\b", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,，。.?")
    return cleaned[:160] or "product"


def extract_merchant_query(text: str) -> str:
    merchant = find_known_local_merchant(text)
    if merchant:
        return merchant["name"]
    note = extract_note(text)
    return note if note != "expense" else "Expense"


def extract_wishlist_item(text: str) -> str:
    cleaned = re.sub(r"(add|create|wishlist|wish list|purchase plan|buy|plan|购买计划|愿望清单|想买|加入)", " ", text, flags=re.I)
    cleaned = re.sub(r"[0-9]+(?:[.,][0-9]+)?\s*(?:eur|euro|euros|€|usd|dollar|dollars|\$|元|块|欧元)?", " ", cleaned, flags=re.I)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ,，。.")
    return cleaned[:120] or "wishlist item"


def extract_location(text: str) -> str:
    if "berlin" in text.lower() or "柏林" in text:
        return "Berlin, Germany"
    if "hamburg" in text.lower() or "汉堡" in text:
        return "Hamburg, Germany"
    return DEFAULT_LOCATION


def extract_email_subject(text: str) -> str:
    match = re.search(r"subject\s+(.+?)(?:\s+saying|\s+body|$)", text, flags=re.I)
    if match:
        return match.group(1).strip()[:120]
    return "Financial App Message"


def extract_email_body(text: str) -> str:
    match = re.search(r"(?:saying|body|内容是)\s+(.+)$", text, flags=re.I)
    if match:
        return match.group(1).strip()
    return text.strip()


def resolve_requested_recipient_emails(text: str) -> list[str]:
    emails = normalize_email_addresses(re.findall(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", text))
    if re.search(r"\b(to me|my email)\b|给我|我自己的邮箱", text, flags=re.I) and os.environ.get("GMAIL_USER"):
        emails.append(os.environ["GMAIL_USER"])
    return [*dict.fromkeys(emails)]


def normalize_email_addresses(value: Any) -> list[str]:
    if isinstance(value, str):
        candidates = re.findall(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", value)
    elif isinstance(value, list):
        candidates = []
        for item in value:
            candidates.extend(normalize_email_addresses(item))
    else:
        candidates = []
    return [email.lower() for email in candidates]


def normalize_retailers(value: Any, product_query: str | None = None) -> list[str]:
    values: list[str]
    if isinstance(value, str):
        values = [value]
    elif isinstance(value, list):
        values = [str(item) for item in value]
    else:
        values = []

    found = []
    for raw in values:
        lower = raw.lower().replace("-", "_").replace(" ", "_")
        if lower in SUPPORTED_RETAILER_IDS:
            found.append(lower)
    if found:
        return [*dict.fromkeys(found)]
    inferred = find_retailer_ids(product_query or "")
    if inferred:
        return inferred
    if product_query and infer_retailers_for_product(product_query):
        return infer_retailers_for_product(product_query) or []
    return []


def find_retailer_ids(text: str) -> list[str]:
    lower = text.lower()
    found = []
    patterns = {
        "mediamarkt": r"media\s*markt|mediamarkt",
        "saturn": r"\bsaturn\b",
        "edeka": r"edeka|edika",
        "rewe": r"\brewe\b",
        "penny": r"\bpenny\b",
        "lidl": r"\blidl\b",
        "aldi": r"\baldi\b",
        "rossmann": r"rossmann",
        "ikea": r"\bikea\b",
        "asian_grocery": r"asian|asia markt|go asia|亚洲|亚超|肉松|pork floss|rousong",
    }
    for retailer_id, pattern in patterns.items():
        if re.search(pattern, lower, flags=re.I):
            found.append(retailer_id)
    return found


def find_known_local_merchant(text: str) -> dict[str, Any] | None:
    lower = text.lower()
    for merchant in KNOWN_LOCAL_MERCHANTS.values():
        if any(alias.lower() in lower or alias in text for alias in merchant["aliases"]):
            return merchant
    return None


def looks_like_deal_request(text: str) -> bool:
    return bool(re.search(r"(discount|deal|coupon|offer|angebote|angebot|promotion|price|stock|availability|打折|折扣|优惠|促销|价格|库存|有货)", text, flags=re.I))


def looks_like_offer_request(text: str) -> bool:
    return bool(re.search(r"(weekly|offers|angebote|prospekt|promotion|优惠|打折|折扣|促销)", text, flags=re.I)) and bool(find_retailer_ids(text))


def looks_like_local_merchant_request(text: str) -> bool:
    return bool(re.search(r"(restaurant|cafe|coffee|mcdonald|burger king|kfc|subway|starbucks|餐厅|咖啡|麦当劳|肯德基|汉堡王|星巴克)", text, flags=re.I))


def looks_like_email_request(lower: str) -> bool:
    return "email" in lower or "mail " in lower or "send " in lower and "@" in lower or "邮件" in lower or "发送" in lower and "@" in lower


def looks_like_send_final_answer_email_request(lower: str) -> bool:
    return bool(re.search(r"(email|mail|send|发送|邮件).*(final|result|answer|结果|答案)|(?:final|result|answer|结果|答案).*(email|mail|发送|邮件)", lower, flags=re.I))


def looks_like_wishlist_request(lower: str) -> bool:
    return "wishlist" in lower or "wish list" in lower or "purchase plan" in lower or "愿望清单" in lower or "购买计划" in lower or "想买" in lower


def looks_like_list_request(lower: str) -> bool:
    return "show" in lower or "list" in lower or "view" in lower or "查看" in lower or "列出" in lower


def looks_like_summary_request(lower: str) -> bool:
    return "spent" in lower and "how" in lower or "summary" in lower or "spending" in lower or "花费" in lower or "支出" in lower and "多少" in lower


def looks_like_overview_request(lower: str) -> bool:
    return "overview" in lower or "recap" in lower or "financial situation" in lower or "总结" in lower or "概览" in lower


def looks_like_profile_request(lower: str) -> bool:
    return "profile" in lower or "balance" in lower or "budget" in lower or "余额" in lower or "预算" in lower


def looks_like_profile_update_request(lower: str) -> bool:
    has_update = (
        "set" in lower
        or "change" in lower
        or "update" in lower
        or "modify" in lower
        or "设置" in lower
        or "修改" in lower
        or "更新" in lower
    )
    has_profile_field = (
        "name" in lower
        or "income" in lower
        or "budget" in lower
        or "balance" in lower
        or "currency" in lower
        or "savings goal" in lower
        or "名字" in lower
        or "收入" in lower
        or "预算" in lower
        or "余额" in lower
        or "货币" in lower
        or "目标" in lower
    )
    return has_update and has_profile_field


def extract_profile_update_args(text: str) -> dict[str, Any]:
    lower = text.lower()
    amount = extract_amount(text)
    args: dict[str, Any] = {}

    if "income" in lower or "收入" in text:
        args["monthlyIncome"] = amount
    elif "budget" in lower or "预算" in text:
        args["monthlyBudget"] = amount
    elif "balance" in lower or "余额" in text:
        args["currentBalance"] = amount
    elif "currency" in lower or "货币" in text:
        args["baseCurrency"] = extract_currency(text)
    elif "savings goal" in lower or "目标" in text:
        args["savingsGoalTargetAmount"] = amount

    name_match = re.search(
        r"(?:name is|name to|叫|名字(?:是|改成|设置为))\s*([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff -]{0,40})",
        text,
        flags=re.I,
    )
    if name_match:
        args["name"] = name_match.group(1).strip()

    return args


def looks_like_delete_expense_request(lower: str) -> bool:
    return "delete" in lower or "remove" in lower or "删除" in lower or "删掉" in lower


def looks_like_expense_request(lower: str) -> bool:
    return "record" in lower or "add" in lower and "expense" in lower or "spent" in lower or "paid" in lower or "记录" in lower or "支出" in lower or "消费" in lower or "花了" in lower


def normalize_response_language(value: Any) -> str:
    return "en" if value == "en" else "zh"


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def normalize_currency(value: Any) -> str | None:
    text = str(value or "").upper().strip()
    aliases = {"EURO": "EUR", "EUROS": "EUR", "€": "EUR", "$": "USD", "DOLLAR": "USD", "DOLLARS": "USD", "RMB": "CNY"}
    text = aliases.get(text, text)
    return text if text in SUPPORTED_CURRENCIES else None


def normalize_category(value: Any, categories: list[str]) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    for category in categories:
        if category.lower() == text.lower():
            return category
    alias = CATEGORY_ALIASES.get(text.lower()) or CATEGORY_ALIASES.get(text)
    if alias:
        for category in categories:
            if category.lower() == alias.lower():
                return category
        return alias
    return None


def normalize_date(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("/", "-")).date().isoformat()
    except ValueError:
        return None


def parse_date(value: Any) -> date | None:
    normalized = normalize_date(value)
    if not normalized:
        return None
    return datetime.fromisoformat(normalized).date()


def to_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(str(value).replace(",", "."))
    except (TypeError, ValueError):
        return None


def round_money(value: Any) -> float:
    number = to_float(value) or 0.0
    return round(number + 1e-9, 2)


def format_money(amount: Any, currency: Any = "EUR") -> str:
    code = normalize_currency(currency) or "EUR"
    symbols = {"EUR": "€", "USD": "$", "GBP": "£", "CNY": "¥", "JPY": "¥"}
    symbol = symbols.get(code, f"{code} ")
    return f"{symbol}{round_money(amount):.2f}"


def truncate(text: str, max_chars: int) -> str:
    return text if len(text) <= max_chars else f"{text[:max_chars]}…"


def emit_text_in_chunks(job: dict[str, Any] | None, text: str) -> None:
    accumulated = ""
    for chunk in re.findall(r".{1,80}(?:\s+|$)", text, flags=re.S) or [text]:
        accumulated += chunk
        realtime.emit_token(job, text=chunk, accumulated_text=accumulated)


def cleanup_transcript(text: str) -> str:
    return re.sub(r"^transcript:\s*", "", text.strip().strip("\"'“”"), flags=re.I).strip()


def unique_values(values: list[Any]) -> list[Any]:
    result = []
    for value in values:
        if value and value not in result:
            result.append(value)
    return result


def extract_inline_audio(response: Any) -> dict[str, Any] | None:
    for candidate in getattr(response, "candidates", []) or []:
        content = getattr(candidate, "content", None)
        for part in getattr(content, "parts", []) or []:
            inline = getattr(part, "inline_data", None) or getattr(part, "inlineData", None)
            if inline and getattr(inline, "data", None):
                return {
                    "data": getattr(inline, "data"),
                    "mimeType": getattr(inline, "mime_type", None) or getattr(inline, "mimeType", None),
                }
    return None


def create_wav_buffer(pcm: bytes, sample_rate: int = 24000, channels: int = 1, bits_per_sample: int = 16) -> bytes:
    byte_rate = sample_rate * channels * bits_per_sample // 8
    block_align = channels * bits_per_sample // 8
    header = b"".join(
        [
            b"RIFF",
            struct.pack("<I", 36 + len(pcm)),
            b"WAVE",
            b"fmt ",
            struct.pack("<IHHIIHH", 16, 1, channels, sample_rate, byte_rate, block_align, bits_per_sample),
            b"data",
            struct.pack("<I", len(pcm)),
        ]
    )
    return header + pcm


def _raise_if_cancelled(job: dict[str, Any] | None) -> None:
    if realtime.is_cancelled(job):
        raise RuntimeError("Realtime job was cancelled by the user.")
