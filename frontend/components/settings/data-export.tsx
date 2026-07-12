"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, DatabaseBackup } from "lucide-react";

export function DataExport() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DatabaseBackup className="h-5 w-5" /> Data & Backups
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-[color:var(--muted)]">
          The app writes a full database snapshot to <code className="font-mono text-xs">data/backups/</code>{" "}
          once a day and keeps the last seven — copy that folder anywhere for safekeeping. You can also
          download your data as JSON right now (passwords, document numbers, and tokens are never included).
        </p>
        <a href="/api/export" download>
          <Button variant="outline" size="sm">
            <Download className="h-4 w-4" /> Export my data (JSON)
          </Button>
        </a>
      </CardContent>
    </Card>
  );
}
