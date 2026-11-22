import hashlib
import hmac
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import database
from engine import process_comments
from matcher import load_rules, match_comment, normalize_text, pick_public_reply, render_dm_text
from meta_client import MetaApiError, MetaGraphClient, is_within_private_reply_window
from webhook_server import parse_webhook_payload, verify_meta_signature


class TestMatcher(unittest.TestCase):
    def setUp(self):
        self.rules = load_rules()

    def test_normalize_text_polish_and_portuguese(self):
        self.assertEqual(normalize_text("Chcę link! Łódź / Orçamento"), "chce link! lodz / orcamento")

    def test_word_boundary_prevents_false_positive(self):
        # "APP" nie powinno dopasować się do słowa "happy" ani "apple"
        self.assertIsNone(match_comment("instagram", "post_1", "So happy with my apple!", self.rules))

    def test_matches_polish_portuguese_spanish(self):
        res_pl = match_comment("instagram", "p1", "Poproszę APP!", self.rules)
        self.assertIsNotNone(res_pl)
        self.assertEqual(res_pl[0]["id"], "serviceapp_download_pl")

        res_br = match_comment("instagram", "p1", "Quero fazer orçamento!", self.rules)
        self.assertIsNotNone(res_br)
        self.assertEqual(res_br[0]["id"], "serviceapp_download_br")

        res_mx = match_comment("facebook", "p2", "Quiero descargar para conseguir chamba", self.rules)
        self.assertIsNotNone(res_mx)
        self.assertEqual(res_mx[0]["id"], "serviceapp_download_mx")

    def test_post_id_restriction_and_exact_mode(self):
        custom_rules = [
            {
                "id": "only_post_99",
                "enabled": True,
                "platforms": ["instagram"],
                "post_ids": ["99"],
                "match_mode": "exact",
                "keywords": ["VIP"],
                "dm_text": "Hej {username}!",
            }
        ]
        self.assertIsNone(match_comment("instagram", "100", "VIP", custom_rules))
        self.assertIsNone(match_comment("instagram", "99", "Chcę VIP proszę", custom_rules))
        self.assertIsNotNone(match_comment("instagram", "99", "  vip! ", custom_rules))

    def test_render_and_public_reply(self):
        rendered = render_dm_text("Cześć @{username}, link: {app_url}", username="@janek", keyword="APP")
        self.assertIn("@janek", rendered)
        self.assertIn("https://", rendered)

        reply = pick_public_reply(self.rules[0], username="janek")
        self.assertTrue(reply and len(reply) > 5)


class TestWindowAndWebhook(unittest.TestCase):
    def test_private_reply_window(self):
        now = datetime(2026, 11, 22, 12, 0, 0, tzinfo=timezone.utc)
        fresh = (now - timedelta(days=2)).strftime("%Y-%m-%dT%H:%M:%S+0000")
        old = (now - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%S+0000")

        self.assertTrue(is_within_private_reply_window(fresh, max_age_days=6, now=now))
        self.assertFalse(is_within_private_reply_window(old, max_age_days=6, now=now))

    def test_webhook_signature_verification(self):
        secret = "super_secret_123"
        body = b'{"object":"instagram","entry":[]}'
        good_sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

        self.assertTrue(verify_meta_signature(body, good_sig, app_secret=secret))
        self.assertFalse(verify_meta_signature(body, "sha256=wrong", app_secret=secret))
        self.assertFalse(verify_meta_signature(body, "", app_secret=secret))

    def test_parse_webhook_payload_ig_and_fb(self):
        ig_payload = {
            "object": "instagram",
            "entry": [
                {
                    "changes": [
                        {
                            "field": "comments",
                            "value": {
                                "id": "ig_c_1",
                                "text": "LINK proszę",
                                "from": {"id": "u_1", "username": "anna_pl"},
                                "media": {"id": "m_1"},
                            },
                        }
                    ]
                }
            ],
        }
        parsed_ig = parse_webhook_payload(ig_payload)
        self.assertEqual(len(parsed_ig), 1)
        self.assertEqual(parsed_ig[0]["platform"], "instagram")
        self.assertEqual(parsed_ig[0]["comment_id"], "ig_c_1")

        fb_payload = {
            "object": "page",
            "entry": [
                {
                    "changes": [
                        {
                            "field": "feed",
                            "value": {
                                "item": "comment",
                                "verb": "add",
                                "comment_id": "fb_c_1",
                                "post_id": "fb_p_1",
                                "message": "APP!",
                                "from": {"id": "fb_u_1", "name": "Piotr Nowak"},
                            },
                        }
                    ]
                }
            ],
        }
        parsed_fb = parse_webhook_payload(fb_payload)
        self.assertEqual(len(parsed_fb), 1)
        self.assertEqual(parsed_fb[0]["platform"], "facebook")
        self.assertEqual(parsed_fb[0]["comment_id"], "fb_c_1")


class TestEngineEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        self.tmp.close()
        self.db_path = self.tmp.name
        database.init_db(self.db_path)
        self.rules = load_rules()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_mock_pipeline_and_deduplication(self):
        client = MetaGraphClient()
        comments = MetaGraphClient.get_mock_comments()

        first_run = process_comments(
            comments,
            self.rules,
            client,
            mock=True,
            db_path=self.db_path,
            reply_delay=0,
        )
        # 4 dopasowane, 1 bez dopasowania, 1 przeterminowany (9 dni)
        self.assertEqual(first_run["stats"]["dm_sent"], 4)
        self.assertEqual(first_run["stats"]["no_match"], 1)
        self.assertEqual(first_run["stats"]["expired"], 1)

        # Drugie uruchomienie na tych samych danych — 0 nowych wysyłek!
        second_run = process_comments(
            comments,
            self.rules,
            client,
            mock=True,
            db_path=self.db_path,
            reply_delay=0,
        )
        self.assertEqual(second_run["stats"]["dm_sent"], 0)
        self.assertEqual(second_run["stats"]["already_processed"], len(comments))

    def test_per_post_user_deduplication_and_live_calls(self):
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")
        client = MagicMock(spec=MetaGraphClient)
        client.send_private_reply.return_value = ("msg_123", {"message_id": "msg_123"})
        client.send_public_reply.return_value = ("rep_456", {"id": "rep_456"})

        comments = [
            {
                "platform": "instagram",
                "comment_id": "c_1",
                "post_id": "p_1",
                "author_id": "user_77",
                "author_username": "tomek",
                "text": "APP!",
                "timestamp": now_iso,
            },
            {
                "platform": "instagram",
                "comment_id": "c_2",
                "post_id": "p_1",
                "author_id": "user_77",
                "author_username": "tomek",
                "text": "LINK proszę jeszcze raz!",
                "timestamp": now_iso,
            },
        ]

        res = process_comments(
            comments,
            self.rules,
            client,
            mock=False,
            dry_run=False,
            db_path=self.db_path,
            reply_delay=0,
        )
        self.assertEqual(res["stats"]["dm_sent"], 1)
        self.assertEqual(res["stats"]["duplicate_user"], 1)
        self.assertEqual(client.send_private_reply.call_count, 1)
        self.assertEqual(client.send_public_reply.call_count, 1)

        st = database.get_stats(self.db_path)
        self.assertEqual(st["dm_sent"], 1)
        self.assertEqual(st["skipped_duplicate_user"], 1)

    def test_meta_api_permanent_error_recorded(self):
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+0000")
        client = MagicMock(spec=MetaGraphClient)
        client.send_private_reply.side_effect = MetaApiError(
            "Already replied privately", status_code=400, error_code=10900
        )

        comments = [
            {
                "platform": "facebook",
                "comment_id": "fb_err_1",
                "post_id": "fb_p_1",
                "author_id": "u_99",
                "author_username": "Adam",
                "text": "LINK",
                "timestamp": now_iso,
            }
        ]
        res = process_comments(
            comments,
            self.rules,
            client,
            mock=False,
            db_path=self.db_path,
            reply_delay=0,
        )
        self.assertEqual(res["stats"]["errors"], 1)
        self.assertTrue(database.is_comment_processed("fb_err_1", db_path=self.db_path))


if __name__ == "__main__":
    unittest.main()
