import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.request import urlopen


ADVISORY_FEED = "https://cna.openjsf.org/feed.xml"
CVE_API = "https://cveawg.mitre.org/api/cve/"
RELEASE_CONFIG = Path(__file__).with_name("release-config.json")
SEVERITY_ORDER = ("NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL")


def download(url):
    with urlopen(url, timeout=15) as response:
        return response.read()


def stable_version(text):
    # shortcut: Only stable Node versions are packaged. Extend if upstream uses prerelease boundaries.
    if not re.fullmatch(r"(0|[1-9][0-9]*)(\.(0|[1-9][0-9]*)){2}", text):
        raise ValueError(f"Unsupported Node.js version: {text}")
    return tuple(map(int, text.split(".")))


def version_status(product, version):
    for entry in product.get("versions", []):
        lower = stable_version(entry["version"])
        exclusive = entry.get("lessThan")
        inclusive = entry.get("lessThanOrEqual")
        if exclusive is not None or inclusive is not None:
            if entry["versionType"] != "semver" or (exclusive is not None and inclusive is not None):
                raise ValueError("Unsupported Node.js version range")
            upper = exclusive if exclusive is not None else inclusive
            limit = None if upper == "*" else stable_version(upper)
            matches = lower <= version and (
                limit is None or version < limit or (inclusive is not None and version == limit)
            )
        else:
            matches = version == lower
        if matches:
            changes = sorted((stable_version(change["at"]), change["status"]) for change in entry.get("changes", []))
            status = entry["status"]
            for at, change_status in changes:
                if at <= version:
                    status = change_status
            return status
    return product.get("defaultStatus", "unknown")


def audit(config, read_url=download):
    node_version = json.loads(config.read_text(encoding="utf-8"))["nodeVersion"]
    version = stable_version(node_version)
    feed = ET.fromstring(read_url(ADVISORY_FEED))
    guids = (item.findtext("guid", "") for item in feed.findall("./channel/item"))
    ids = {guid.removesuffix("::node") for guid in guids if guid.endswith("::node")}
    if not ids or any(not re.fullmatch(r"CVE-[0-9]{4}-[0-9]{4,}", cve_id) for cve_id in ids):
        raise ValueError("Invalid OpenJS Node.js advisory index")

    findings = []
    for cve_id in sorted(ids):
        record = json.loads(read_url(CVE_API + cve_id))
        metadata = record["cveMetadata"]
        if metadata["cveId"] != cve_id or metadata["state"] not in ("PUBLISHED", "REJECTED"):
            raise ValueError(f"Unexpected CVE record for {cve_id}")
        if metadata["state"] == "REJECTED":
            continue
        cna = record["containers"]["cna"]
        statuses = {
            version_status(product, version)
            for product in cna["affected"]
            if product["vendor"] == "nodejs" and product["product"] == "node"
        }
        if not statuses or not statuses <= {"affected", "unaffected"}:
            raise ValueError(f"Missing version determination for {cve_id}")
        if "affected" not in statuses:
            continue

        severities = [
            metric[key]["baseSeverity"]
            for metric in cna.get("metrics", [])
            for key in ("cvssV4_0", "cvssV3_1", "cvssV3_0")
            if key in metric
        ]
        if not severities or any(severity not in SEVERITY_ORDER for severity in severities):
            raise ValueError(f"Missing or invalid CVSS severity for {cve_id}")
        severity = max(severities, key=SEVERITY_ORDER.index)
        if severity in ("HIGH", "CRITICAL"):
            findings.append({"id": cve_id, "severity": severity, "url": f"https://www.cve.org/CVERecord?id={cve_id}"})
    return {"nodeVersion": node_version, "findings": findings}


if __name__ == "__main__":
    result = audit(RELEASE_CONFIG)
    print(json.dumps(result, indent=2))
    if result["findings"]:
        output = os.environ.get("GITHUB_OUTPUT")
        if not output:
            sys.exit(1)
        with Path(output).open("a", encoding="utf-8") as stream:
            stream.write("vulnerable=true\n")
