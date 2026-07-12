import { Sidebar } from "@/components/layout/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[color:var(--ground)]">
      <Sidebar />
      <main className="min-h-screen px-4 pb-10 pt-[4.5rem] md:ml-64 md:px-8 md:pb-12 md:pt-8">
        <div className="mx-auto max-w-6xl">{children}</div>
      </main>
    </div>
  );
}
