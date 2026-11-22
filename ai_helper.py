import json
import urllib.request
from config import GEMINI_API_KEY, GEMINI_MODEL, APP_NAME


def personalize_dm_with_gemini(
    base_dm: str,
    comment_text: str,
    username: str,
    platform: str,
) -> str:
    """
    Opcjonalnie dopracowuje początek DM przez Google Gemini,
    zachowując wszystkie linki z szablonu. Jeśli GEMINI_API_KEY nie jest ustawiony
    lub wystąpi błąd sieci, zwraca bez zmian oryginalny szablon base_dm.
    """
    if not GEMINI_API_KEY:
        return base_dm

    prompt = (
        f"Jesteś asystentem marki {APP_NAME} odpowiadającym w prywatnej wiadomości ({platform}) "
        f"na komentarz użytkownika @{username}.\n"
        f"Komentarz użytkownika: {comment_text}\n\n"
        f"Bazowa wiadomość DM (zachowaj w 100% wszystkie linki URL oraz język tej wiadomości):\n"
        f"{base_dm}\n\n"
        f"Zadanie: napisz krótką, przyjazną, naturalną wiadomość DM (maks. 600 znaków) "
        f"nawiązującą lekko do komentarza użytkownika, zachowując dokładnie wszystkie linki z bazowej wiadomości. "
        f"Zwróć wyłącznie gotową treść wiadomości, bez cudzysłowów i bez komentarzy."
    )

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.4, "maxOutputTokens": 350},
    }

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        candidates = data.get("candidates") or []
        if not candidates:
            return base_dm
        parts = candidates[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        return text if text else base_dm
    except Exception as e:
        print(f"[!] Gemini fallback (użyto szablonu DM): {e}")
        return base_dm
