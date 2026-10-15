import { Sidebar } from "@/components/layout/sidebar";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <Sidebar />
      <main className="min-w-0 flex-1 px-4 pb-4 pt-16 md:ml-64 md:p-8">{children}</main>
    </div>
  );
}
