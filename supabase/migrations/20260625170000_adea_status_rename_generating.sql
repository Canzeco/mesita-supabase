-- Rename ADEA lifecycle states: 'running' is in-flight enrichment work,
-- now spelled 'generating'; 'pending' is reserved for the future bulk
-- path and renamed 'queued'. 'ready' and 'failed' are unchanged.
alter type public.adea_status rename value 'running' to 'generating';
alter type public.adea_status rename value 'pending' to 'queued';
