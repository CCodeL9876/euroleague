// Zugang zur Supabase-Funktion „euroleague“ (supabase/functions/euroleague). Dasselbe Supabase-Projekt wie die
// Haushalt-App. Der „publishable“/„anon“ Key ist für den Browser gedacht und darf öffentlich sein.
export const SUPABASE_URL = 'https://vbipkljatgandplwould.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_dg4tPjjsYOGRHxuf0Is43Q_LZRRzfs4';

// „Sport“ im Titel führt zur KI-News-Seite
export const KI_NEWS_URL = 'https://claude.ai/artifact/A79MLhwGijoouiwS9h3tWW';

// Links ganz unten zu den anderen Sport-Seiten (disabled: zurzeit ohne Ausgabe)
export const RUBRIKEN = [
  { name: 'Alle anzeigen', url: 'https://claude.ai/artifact/KnpRvCkmZyPPwwTiYoJwm4' },
  { name: 'NBA', url: 'https://claude.ai/artifact/1FEndvb8nRpiaYaZPoJxZA', disabled: true },
  { name: 'Premier League', url: 'https://claude.ai/artifact/BXujdHSYyZyFDAK2y7KPAe' },
  { name: 'NFL', url: 'https://claude.ai/artifact/R3M53ggKX66PmfDi7zQotw', disabled: true },
  { name: 'Schweizer Fussball', url: 'https://claude.ai/artifact/EhutNKEQzHgFHu4BUANo6d' },
  { name: 'Euroleague', url: './', active: true },
  { name: 'Volleyball', url: 'https://claude.ai/artifact/T69iBgfZN8xPRM6MHMF2mw' },
  { name: 'Basketball Regional', url: 'https://claude.ai/artifact/1WpLQi1K3LUK5bbwxHeUnm' },
];
