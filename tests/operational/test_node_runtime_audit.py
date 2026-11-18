import json
import tempfile
import unittest
from pathlib import Path

from scripts.node_runtime_audit import ADVISORY_FEED, CVE_API, audit


CVE_ID = "CVE-2026-123872"


def advisory(cve_id, severity, minimum="0.0.0", fixed="22.23.5"):
    return {
        "cveMetadata": {"cveId": cve_id, "state": "PUBLISHED"},
        "containers": {"cna": {
            "affected": [{
                "vendor": "nodejs",
                "product": "node",
                "defaultStatus": "unaffected",
                "versions": [{
                    "version": minimum,
                    "lessThan": fixed,
                    "versionType": "semver",
                    "status": "affected",
                }],
            }],
            "metrics": [{"cvssV3_0": {"baseSeverity": severity}}],
        }},
    }


def fixture_feed(*records):
    items = ["<item><guid>CVE-2026-12345::unrelated</guid></item>"]
    responses = {}
    for record in records:
        cve_id = record["cveMetadata"]["cveId"]
        items.append(f"<item><guid>{cve_id}::node</guid></item>")
        responses[CVE_API + cve_id] = json.dumps(record).encode()
    responses[ADVISORY_FEED] = ("<rss><channel>" + "".join(items) + "</channel></rss>").encode()
    return responses.__getitem__


class NodeRuntimeAuditTest(unittest.TestCase):
    def test_reports_only_high_and_critical_in_the_bundled_release(self):
        critical = "CVE-2099-10001"
        read_url = fixture_feed(
            advisory(CVE_ID, "HIGH"),
            advisory(critical, "CRITICAL"),
            advisory("CVE-2026-123874", "MEDIUM"),
            advisory("CVE-2026-123875", "HIGH", minimum="24.0.0", fixed="24.22.3"),
        )
        cases = [
            ("22.23.3", [(CVE_ID, "HIGH"), (critical, "CRITICAL")]),
            ("22.23.5", []),
        ]
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "release-config.json"
            for version, expected in cases:
                with self.subTest(version=version):
                    config.write_text(json.dumps({"nodeVersion": version}), encoding="utf-8")
                    result = audit(config, read_url)
                    self.assertEqual(result["nodeVersion"], version)
                    self.assertEqual(
                        [(finding["id"], finding["severity"]) for finding in result["findings"]],
                        expected,
                    )

    def test_unavailable_or_invalid_advisories_fail_the_scan(self):
        def unavailable(_url):
            raise TimeoutError("advisory service unavailable")

        cases = [
            (unavailable, TimeoutError),
            (lambda _url: b"<rss><channel/></rss>", ValueError),
            (fixture_feed(advisory(CVE_ID, "UNKNOWN")), ValueError),
        ]
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "release-config.json"
            config.write_text('{"nodeVersion":"22.23.3"}', encoding="utf-8")
            for read_url, error in cases:
                with self.subTest(error=error):
                    with self.assertRaises(error):
                        audit(config, read_url)


if __name__ == "__main__":
    unittest.main()
