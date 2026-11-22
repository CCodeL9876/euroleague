-- Tageszähler für die Abfrage-Kontingente (Sportradar, Big Balls, GOAL, Spielerprofile) der Funktion «fussball».
-- Zählt atomar in der Tabelle el_fb_cache: gleichzeitige Server-Prozesse können die Grenze so nicht mehr überspringen.
-- Einmal im Supabase-Dashboard unter «SQL Editor» einfügen und ausführen.
-- Rückgabe: true = Abfrage erlaubt (Zähler erhöht), false = Tagesgrenze erreicht.
create or replace function public.el_fb_incr(k text, lim integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into public.el_fb_cache as c (key, data, at)
  values (k, to_jsonb(1), now())
  on conflict (key) do update
    set data = to_jsonb(coalesce((c.data #>> '{}')::integer, 0) + 1), at = now()
    where coalesce((c.data #>> '{}')::integer, 0) < lim
  returning (data #>> '{}')::integer into n;
  return n is not null and n <= lim;
end;
$$;

-- Nur der Server (service_role) darf zählen, nicht die öffentliche App
revoke all on function public.el_fb_incr(text, integer) from public, anon, authenticated;
grant execute on function public.el_fb_incr(text, integer) to service_role;
