import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from config import (
    META_GRAPH_API_VERSION,
    META_ACCESS_TOKEN,
    FB_PAGE_ACCESS_TOKEN,
    IG_USER_ID,
    IG_USERNAME,
    FB_PAGE_ID,
    MAX_POSTS_PER_PLATFORM,
    MAX_COMMENTS_PER_POST,
    MAX_COMMENT_AGE_DAYS,
)


class MetaApiError(Exception):
    """Wyjątek reprezentujący błąd zwrócony przez Meta Graph API."""

    def __init__(
        self,
        message: str,
        status_code: int = 0,
        error_code: Optional[int] = None,
        error_subcode: Optional[int] = None,
    ):
        super().__init__(message)
        self.status_code = status_code
        self.error_code = error_code
        self.error_subcode = error_subcode


def parse_meta_timestamp(raw_ts: Optional[str]) -> Optional[datetime]:
    """Parsuje format znaczników czasu Meta (np. 2026-11-22T14:30:00+0000 lub Z)."""
    if not raw_ts:
        return None
    ts = raw_ts.strip()
    if ts.endswith("Z"):
        ts = ts[:-1] + "+00:00"
    elif len(ts) >= 5 and (ts[-5] in ("+", "-")) and ts[-3] != ":":
        ts = ts[:-2] + ":" + ts[-2:]
    try:
        dt = datetime.fromisoformat(ts)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def is_within_private_reply_window(
    raw_ts: Optional[str],
    max_age_days: int = MAX_COMMENT_AGE_DAYS,
    now: Optional[datetime] = None,
) -> bool:
    """Sprawdza, czy komentarz mieści się w 7-dniowym oknie Meta Private Replies."""
    dt = parse_meta_timestamp(raw_ts)
    if dt is None:
        return True
    ref_now = now or datetime.now(timezone.utc)
    return (ref_now - dt) <= timedelta(days=max_age_days)


class MetaGraphClient:
    """
    Klient Meta Graph API (zero zewnętrznych zależności) obsługujący:
    - Instagram Business / Creator (pobieranie postów/rolek, komentarzy, Private Reply DM, odpowiedź pod komentarzem)
    - Facebook Page (pobieranie postów, komentarzy, Private Reply DM, odpowiedź pod komentarzem)
    """

    def __init__(
        self,
        api_version: str = META_GRAPH_API_VERSION,
        meta_token: str = META_ACCESS_TOKEN,
        fb_page_token: str = FB_PAGE_ACCESS_TOKEN,
        ig_user_id: str = IG_USER_ID,
        ig_username: str = IG_USERNAME,
        fb_page_id: str = FB_PAGE_ID,
    ):
        self.base_url = f"https://graph.facebook.com/{api_version}"
        self.meta_token = meta_token.strip()
        self.fb_page_token = (fb_page_token or meta_token).strip()
        self.ig_user_id = ig_user_id.strip()
        self.ig_username = ig_username.strip().lstrip("@").lower()
        self.fb_page_id = fb_page_id.strip()

    def is_instagram_configured(self) -> bool:
        return bool(self.meta_token and self.ig_user_id)

    def is_facebook_configured(self) -> bool:
        return bool(self.fb_page_token and self.fb_page_id)

    def _request(
        self,
        method: str,
        path: str,
        token: str,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        timeout: int = 20,
    ) -> Dict[str, Any]:
        query = dict(params or {})
        query["access_token"] = token
        encoded_query = urllib.parse.urlencode(query)
        url = f"{self.base_url}/{path.lstrip('/')}?{encoded_query}"

        headers = {
            "User-Agent": "ServiceAppCommentToDMBot/1.0",
            "Accept": "application/json",
        }
        data = None
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            body_text = ""
            try:
                body_text = e.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            err_code = None
            err_subcode = None
            err_msg = f"HTTP {e.code}"
            try:
                parsed = json.loads(body_text)
                err_obj = parsed.get("error", {})
                err_code = err_obj.get("code")
                err_subcode = err_obj.get("error_subcode")
                err_msg = err_obj.get("message") or body_text or err_msg
            except Exception:
                if body_text:
                    err_msg = f"HTTP {e.code}: {body_text[:300]}"
            raise MetaApiError(
                err_msg,
                status_code=e.code,
                error_code=err_code,
                error_subcode=err_subcode,
            ) from e
        except urllib.error.URLError as e:
            raise MetaApiError(f"Błąd sieci Meta Graph API: {e}") from e

    # --------------------------------------------------------------------------
    # WERYFIKACJA KONFIGURACJI (--test-meta)
    # --------------------------------------------------------------------------
    def verify_credentials(self) -> Dict[str, Any]:
        results: Dict[str, Any] = {
            "instagram": {"configured": self.is_instagram_configured(), "ok": False},
            "facebook": {"configured": self.is_facebook_configured(), "ok": False},
        }

        if self.is_instagram_configured():
            try:
                data = self._request(
                    "GET",
                    self.ig_user_id,
                    token=self.meta_token,
                    params={"fields": "id,username,name,followers_count"},
                )
                results["instagram"]["ok"] = True
                results["instagram"]["account"] = data
                if not self.ig_username and data.get("username"):
                    self.ig_username = str(data["username"]).lower()
            except MetaApiError as e:
                results["instagram"]["error"] = str(e)
                results["instagram"]["error_code"] = e.error_code

        if self.is_facebook_configured():
            try:
                data = self._request(
                    "GET",
                    self.fb_page_id,
                    token=self.fb_page_token,
                    params={"fields": "id,name,link"},
                )
                results["facebook"]["ok"] = True
                results["facebook"]["page"] = data
            except MetaApiError as e:
                results["facebook"]["error"] = str(e)
                results["facebook"]["error_code"] = e.error_code

        return results

    # --------------------------------------------------------------------------
    # INSTAGRAM — POBIERANIE POSTÓW I KOMENTARZY
    # --------------------------------------------------------------------------
    def fetch_instagram_comments(
        self,
        max_posts: int = MAX_POSTS_PER_PLATFORM,
        max_comments: int = MAX_COMMENTS_PER_POST,
    ) -> List[Dict[str, Any]]:
        if not self.is_instagram_configured():
            return []

        # Jeśli IG_USERNAME nie zostało podane ręcznie, spróbuj pobrać je z API, aby filtrować własne komentarze
        if not self.ig_username:
            try:
                profile = self._request(
                    "GET",
                    self.ig_user_id,
                    token=self.meta_token,
                    params={"fields": "id,username"},
                )
                if profile.get("username"):
                    self.ig_username = str(profile["username"]).lower()
            except MetaApiError:
                pass

        media_resp = self._request(
            "GET",
            f"{self.ig_user_id}/media",
            token=self.meta_token,
            params={
                "fields": "id,caption,permalink,timestamp,media_type",
                "limit": max_posts,
            },
        )
        media_items = media_resp.get("data", [])
        comments: List[Dict[str, Any]] = []

        for media in media_items:
            media_id = str(media.get("id", ""))
            if not media_id:
                continue
            permalink = media.get("permalink", "")
            caption = (media.get("caption") or "")[:140]

            try:
                c_resp = self._request(
                    "GET",
                    f"{media_id}/comments",
                    token=self.meta_token,
                    params={
                        "fields": "id,text,username,timestamp,from,hidden",
                        "limit": max_comments,
                    },
                )
            except MetaApiError as e:
                print(f"[!] Instagram: nie udało się pobrać komentarzy dla posta {media_id}: {e}")
                continue

            for item in c_resp.get("data", []):
                if item.get("hidden"):
                    continue
                from_obj = item.get("from") or {}
                author_id = str(from_obj.get("id") or "")
                author_username = str(item.get("username") or from_obj.get("username") or "").lstrip("@")

                # Odfiltruj własne komentarze konta
                if author_id and author_id == self.ig_user_id:
                    continue
                if self.ig_username and author_username.lower() == self.ig_username:
                    continue

                comments.append(
                    {
                        "platform": "instagram",
                        "comment_id": str(item.get("id", "")),
                        "post_id": media_id,
                        "post_url": permalink,
                        "post_caption": caption,
                        "author_id": author_id,
                        "author_username": author_username or "użytkownik",
                        "text": str(item.get("text") or ""),
                        "timestamp": item.get("timestamp"),
                    }
                )

        return comments

    # --------------------------------------------------------------------------
    # FACEBOOK — POBIERANIE POSTÓW I KOMENTARZY
    # --------------------------------------------------------------------------
    def fetch_facebook_comments(
        self,
        max_posts: int = MAX_POSTS_PER_PLATFORM,
        max_comments: int = MAX_COMMENTS_PER_POST,
    ) -> List[Dict[str, Any]]:
        if not self.is_facebook_configured():
            return []

        posts_resp = self._request(
            "GET",
            f"{self.fb_page_id}/posts",
            token=self.fb_page_token,
            params={
                "fields": "id,message,permalink_url,created_time",
                "limit": max_posts,
            },
        )
        post_items = posts_resp.get("data", [])
        comments: List[Dict[str, Any]] = []

        for post in post_items:
            post_id = str(post.get("id", ""))
            if not post_id:
                continue
            permalink = post.get("permalink_url", "")
            caption = (post.get("message") or "")[:140]

            try:
                c_resp = self._request(
                    "GET",
                    f"{post_id}/comments",
                    token=self.fb_page_token,
                    params={
                        "fields": "id,message,from,created_time",
                        "filter": "stream",
                        "order": "reverse_chronological",
                        "limit": max_comments,
                    },
                )
            except MetaApiError as e:
                print(f"[!] Facebook: nie udało się pobrać komentarzy dla posta {post_id}: {e}")
                continue

            for item in c_resp.get("data", []):
                from_obj = item.get("from") or {}
                author_id = str(from_obj.get("id") or "")
                author_name = str(from_obj.get("name") or "użytkownik")

                # Odfiltruj własne komentarze strony
                if author_id and author_id == self.fb_page_id:
                    continue

                comments.append(
                    {
                        "platform": "facebook",
                        "comment_id": str(item.get("id", "")),
                        "post_id": post_id,
                        "post_url": permalink,
                        "post_caption": caption,
                        "author_id": author_id,
                        "author_username": author_name,
                        "text": str(item.get("message") or ""),
                        "timestamp": item.get("created_time"),
                    }
                )

        return comments

    # --------------------------------------------------------------------------
    # WYSYŁKA PRIVATE REPLY (DM) ORAZ PUBLICZNEJ ODPOWIEDZI POD KOMENTARZEM
    # --------------------------------------------------------------------------
    def send_private_reply(
        self,
        platform: str,
        comment_id: str,
        dm_text: str,
        quick_replies: Optional[List[Dict[str, str]]] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Wysyła prywatną wiadomość (DM) bezpośrednio w odpowiedzi na comment_id
        (Meta Private Replies API).
        """
        message_payload: Dict[str, Any] = {"text": dm_text}
        if quick_replies:
            formatted_qr = []
            for qr in quick_replies[:13]:
                title = str(qr.get("title") or "").strip()[:20]
                payload = str(qr.get("payload") or title).strip()[:1000]
                if title:
                    formatted_qr.append(
                        {
                            "content_type": "text",
                            "title": title,
                            "payload": payload,
                        }
                    )
            if formatted_qr:
                message_payload["quick_replies"] = formatted_qr

        body = {
            "recipient": {"comment_id": comment_id},
            "message": message_payload,
        }

        if platform == "instagram":
            endpoint = f"{self.ig_user_id}/messages"
            token = self.meta_token
        elif platform == "facebook":
            endpoint = f"{self.fb_page_id}/messages"
            token = self.fb_page_token
        else:
            raise ValueError(f"Nieznana platforma: {platform}")

        resp = self._request("POST", endpoint, token=token, json_body=body)
        message_id = str(resp.get("message_id") or resp.get("id") or "")
        return message_id, resp

    def send_public_reply(
        self,
        platform: str,
        comment_id: str,
        reply_text: str,
    ) -> Tuple[str, Dict[str, Any]]:
        """Wysyła publiczną odpowiedź pod komentarzem na Instagramie lub Facebooku."""
        if platform == "instagram":
            endpoint = f"{comment_id}/replies"
            token = self.meta_token
        elif platform == "facebook":
            endpoint = f"{comment_id}/comments"
            token = self.fb_page_token
        else:
            raise ValueError(f"Nieznana platforma: {platform}")

        resp = self._request(
            "POST",
            endpoint,
            token=token,
            json_body={"message": reply_text},
        )
        reply_id = str(resp.get("id") or "")
        return reply_id, resp

    # --------------------------------------------------------------------------
    # DANE DEMONSTRACYJNE (--mock)
    # --------------------------------------------------------------------------
    @staticmethod
    def get_mock_comments() -> List[Dict[str, Any]]:
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")
        old_iso = (datetime.now(timezone.utc) - timedelta(days=9)).strftime("%Y-%m-%dT%H:%M:%S+0000")
        return [
            {
                "platform": "instagram",
                "comment_id": "mock_ig_c_1001",
                "post_id": "mock_ig_post_01",
                "post_url": "https://www.instagram.com/reel/ServiceAppDemo1/",
                "post_caption": "Napisz APP w komentarzu, a wyślemy Ci link do darmowej aplikacji ServiceApp!",
                "author_id": "ig_user_501",
                "author_username": "kasia_remonty",
                "text": "Poproszę APP! Super pomysł 🔥",
                "timestamp": now_iso,
            },
            {
                "platform": "instagram",
                "comment_id": "mock_ig_c_1002",
                "post_id": "mock_ig_post_01",
                "post_url": "https://www.instagram.com/reel/ServiceAppDemo1/",
                "post_caption": "Napisz APP w komentarzu, a wyślemy Ci link do darmowej aplikacji ServiceApp!",
                "author_id": "ig_user_502",
                "author_username": "lucas_eletricista_sp",
                "text": "QUERO baixar o aplicativo para conseguir mais clientes!",
                "timestamp": now_iso,
            },
            {
                "platform": "facebook",
                "comment_id": "mock_fb_c_2001",
                "post_id": "mock_fb_post_01",
                "post_url": "https://www.facebook.com/serviceapp.mobi/posts/2001",
                "post_caption": "Szukasz fachowca albo zleceń? Napisz LINK w komentarzu!",
                "author_id": "fb_user_801",
                "author_username": "Marek Kowalski",
                "text": "LINK proszę, chętnie sprawdzę ServiceApp",
                "timestamp": now_iso,
            },
            {
                "platform": "facebook",
                "comment_id": "mock_fb_c_2002",
                "post_id": "mock_fb_post_02",
                "post_url": "https://www.facebook.com/serviceapp.mobi/posts/2002",
                "post_caption": "¿Buscas chamba o servicios? Comenta DESCARGAR",
                "author_id": "fb_user_802",
                "author_username": "Carlos Mendoza",
                "text": "DESCARGAR por favor!",
                "timestamp": now_iso,
            },
            {
                "platform": "instagram",
                "comment_id": "mock_ig_c_1003_nomatch",
                "post_id": "mock_ig_post_01",
                "post_url": "https://www.instagram.com/reel/ServiceAppDemo1/",
                "post_caption": "Napisz APP w komentarzu!",
                "author_id": "ig_user_503",
                "author_username": "janek_test",
                "text": "Super rolka, pozdrawiam!",
                "timestamp": now_iso,
            },
            {
                "platform": "instagram",
                "comment_id": "mock_ig_c_1004_expired",
                "post_id": "mock_ig_post_00",
                "post_url": "https://www.instagram.com/p/ServiceAppOldPost/",
                "post_caption": "Starszy post sprzed 9 dni",
                "author_id": "ig_user_504",
                "author_username": "stary_komentarz",
                "text": "LINK poproszę",
                "timestamp": old_iso,
            },
        ]
