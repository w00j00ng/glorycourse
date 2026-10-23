ALTER TABLE applications RENAME COLUMN ministry TO affiliation;
ALTER TABLE allocation_draft_items RENAME COLUMN ministry TO affiliation;
ALTER TABLE enrollments RENAME COLUMN ministry TO affiliation;
ALTER TABLE allocation_snapshot_applications RENAME COLUMN ministry TO affiliation;
ALTER TABLE allocation_snapshot_existing_enrollments RENAME COLUMN ministry TO affiliation;
