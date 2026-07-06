-- Follow-up to 20260706000139: the projects_view INSTEAD-OF trigger functions
-- carry the default EXECUTE-to-PUBLIC grant, so anon/authenticated inherited it
-- via PUBLIC and the direct-role revoke was a no-op. Strip the PUBLIC grant so
-- anon/authenticated actually lose EXECUTE. service_role keeps its direct grant;
-- triggers fire regardless of EXECUTE, so updatable-view writes are unaffected.

revoke execute on function public.projects_view_insert() from public;
revoke execute on function public.projects_view_update() from public;
revoke execute on function public.projects_view_delete() from public;
