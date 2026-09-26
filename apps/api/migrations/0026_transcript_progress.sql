-- How far an automatic transcript has come (0–100), shown to the teacher while it runs.
alter table media_transcripts add column if not exists progress smallint
  check (progress between 0 and 100);
