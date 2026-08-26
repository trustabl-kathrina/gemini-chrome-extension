import { SCENES } from '@/src/protocol';

/** Placeholder shell — the real Home / Run / Settings views land with the skills model. */
export function App() {
  return (
    <div className="bloom flex h-full flex-col">
      <header className="hairline-b flex items-center gap-2 px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-accent" />
        <span className="font-medium tracking-tight">Dayflow</span>
        <span className="ml-auto text-fg-3">mock</span>
      </header>
      <main className="flex-1 overflow-y-auto p-3">
        <ul className="flex flex-col gap-1.5">
          {SCENES.map((s) => (
            <li key={s.id} className="hairline rounded-md bg-bg-1 px-3 py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.title}</span>
                <span className="kbd ml-auto">{s.key}</span>
              </div>
              <p className="text-fg-2">{s.blurb}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
