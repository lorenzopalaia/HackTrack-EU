import { NextResponse } from "next/server";
import { Octokit } from "@octokit/rest";
import { supabaseAdmin } from "@/lib/supabase";
import { LumaParser } from "@/lib/parsers/luma-parser";
import { ParsedHackathon } from "@/lib/parsers/base-parser";
import { DiscordBot } from "@/lib/bots/discord-bot";
import { TelegramBot } from "@/lib/bots/telegram-bot";
import { TwitterBot } from "@/lib/bots/twitter-bot";
import { ReadmeUpdater } from "@/lib/services/readme-updater";
import { LocationEnhancementService } from "@/lib/services/location-enhancement-service";
import { MemoryOptimizer } from "@/lib/utils/memory-optimizer";
import { Hackathon } from "@/types/hackathon";

interface SourceResult {
  enabled: boolean;
  success: boolean;
  parsed: number;
  error: string | null;
}

export async function POST(request: Request) {
  try {
    // ---------------------------------------------------------
    // Initial diagnostics
    // ---------------------------------------------------------
    MemoryOptimizer.logMemoryUsage("Initial memory");

    // ---------------------------------------------------------
    // Authentication
    // ---------------------------------------------------------
    const authHeader = request.headers.get("authorization");

    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // ---------------------------------------------------------
    // Request mode
    // ---------------------------------------------------------
    const testMode = request.headers.get("x-test-mode") === "true";

    console.log(
      `Starting hackathon update${
        testMode ? " (TEST MODE - no notifications/README)" : ""
      }...`,
    );

    // ---------------------------------------------------------
    // Source configuration
    //
    // LabLab is intentionally disabled for now because its
    // public web surface is protected by Cloudflare and cannot
    // currently be queried reliably server-side.
    // ---------------------------------------------------------
    const sourceResults: Record<string, SourceResult> = {
      luma: {
        enabled: true,
        success: false,
        parsed: 0,
        error: null,
      },
      lablab: {
        enabled: false,
        success: true,
        parsed: 0,
        error: null,
      },
    };

    // ---------------------------------------------------------
    // 0. Reset is_new flags
    // ---------------------------------------------------------
    let resetError: string | null = null;

    try {
      const { error } = await supabaseAdmin
        .from("hackathons")
        // @ts-expect-error - Supabase generated types may not include update shape
        .update({ is_new: false })
        .neq("id", "00000000-0000-0000-0000-000000000000");

      if (error) {
        resetError = error.message;
        console.error("Error resetting is_new flags:", error);
      } else {
        console.log("Reset all is_new flags to false");
      }
    } catch (error) {
      resetError =
        error instanceof Error ? error.message : "Failed to reset is_new flags";

      console.error("Error resetting is_new flags:", error);
    }

    // ---------------------------------------------------------
    // 1. Parse sources
    // ---------------------------------------------------------
    const parsedHackathons: ParsedHackathon[] = [];

    // ---------------------------------------------------------
    // Luma
    // ---------------------------------------------------------
    try {
      const lumaParser = new LumaParser();
      const lumaHackathons = await lumaParser.parse();

      sourceResults.luma.success = true;
      sourceResults.luma.parsed = lumaHackathons.length;

      parsedHackathons.push(...lumaHackathons);

      console.log(`Parsed ${lumaHackathons.length} hackathons from Luma`);
    } catch (error) {
      sourceResults.luma.success = false;
      sourceResults.luma.error =
        error instanceof Error ? error.message : "Luma parser failed";

      console.error("Luma parser failed:", error);
    }

    // ---------------------------------------------------------
    // LabLab
    //
    // Intentionally disabled for now.
    // ---------------------------------------------------------
    console.log(
      "Lablab parser disabled: source is currently unavailable server-side",
    );

    console.log(`Total parsed ${parsedHackathons.length} hackathons`);

    // ---------------------------------------------------------
    // Fail fast only if every enabled source failed.
    //
    // We still continue with any successful source, but GitHub
    // should know that the update was incomplete.
    // ---------------------------------------------------------
    const enabledSources = Object.entries(sourceResults).filter(
      ([, result]) => result.enabled,
    );

    const allEnabledSourcesFailed =
      enabledSources.length > 0 &&
      enabledSources.every(([, result]) => !result.success);

    // ---------------------------------------------------------
    // Memory diagnostics
    // ---------------------------------------------------------
    MemoryOptimizer.logMemoryUsage("After parsing");

    // ---------------------------------------------------------
    // Deduplicate
    // ---------------------------------------------------------
    const deduplicatedHackathons = parsedHackathons.reduce(
      (acc, hackathon) => {
        const key = `${hackathon.name.toLowerCase().trim()}-${
          hackathon.date_start.toISOString().split("T")[0]
        }`;

        if (!acc.seen.has(key)) {
          acc.seen.add(key);
          acc.hackathons.push(hackathon);
        }

        return acc;
      },
      {
        seen: new Set<string>(),
        hackathons: [] as ParsedHackathon[],
      },
    ).hackathons;

    console.log(
      `After deduplication: ${deduplicatedHackathons.length} hackathons`,
    );

    await MemoryOptimizer.allowGarbageCollection();
    MemoryOptimizer.logMemoryUsage("After deduplication");

    // ---------------------------------------------------------
    // 1.5 Location enhancement
    // ---------------------------------------------------------
    console.log("Starting location enhancement with geocoding...");

    const existingUrlsForLocation =
      await LocationEnhancementService.getExistingUrls(supabaseAdmin);

    console.log(
      `Found ${existingUrlsForLocation.size} existing hackathon URLs in database`,
    );

    const enhancedHackathons =
      await LocationEnhancementService.enhanceLocations(
        deduplicatedHackathons,
        existingUrlsForLocation,
      );

    console.log(
      `After location enhancement: ${enhancedHackathons.length} hackathons`,
    );

    // ---------------------------------------------------------
    // 2. Insert new hackathons
    // ---------------------------------------------------------
    const newHackathons: Hackathon[] = [];
    let insertionError: string | null = null;

    try {
      if (enhancedHackathons.length === 0) {
        console.log("No hackathons available for insertion");
      } else {
        const urlsToCheck = enhancedHackathons.map(
          (hackathon) => hackathon.url,
        );

        const { data: existingHackathons, error: existingCheckError } =
          await supabaseAdmin
            .from("hackathons")
            .select("url")
            .in("url", urlsToCheck);

        if (existingCheckError) {
          throw existingCheckError;
        }

        const existingUrls = new Set(
          existingHackathons?.map(
            (hackathon: { url: string }) => hackathon.url,
          ) || [],
        );

        console.log(`Found ${existingUrls.size} existing hackathons`);

        const hackathonsToInsert = enhancedHackathons
          .filter((hackathon) => !existingUrls.has(hackathon.url))
          .map((hackathon) => ({
            name: hackathon.name,
            city: hackathon.city || null,
            country_code: hackathon.country_code || null,
            date_start: hackathon.date_start.toISOString().split("T")[0],
            date_end: hackathon.date_end?.toISOString().split("T")[0] || null,
            topics: hackathon.topics || null,
            notes: hackathon.notes || null,
            url: hackathon.url,
            source: hackathon.source,
            notified: testMode,
            is_new: true,
          }));

        if (hackathonsToInsert.length > 0) {
          console.log(
            `Inserting ${hackathonsToInsert.length} new hackathons in batch...`,
          );

          const { data: inserted, error } = await supabaseAdmin
            .from("hackathons")
            // @ts-expect-error - Supabase generated types may not include insert shape
            .insert(hackathonsToInsert)
            .select();

          if (error) {
            throw error;
          }

          if (inserted) {
            newHackathons.push(...inserted);

            console.log(
              `Successfully inserted ${inserted.length} new hackathons`,
            );
          }
        } else {
          console.log("No new hackathons to insert");
        }
      }
    } catch (error) {
      insertionError =
        error instanceof Error ? error.message : "Database insertion failed";

      console.error("Database insertion failed:", error);
    }

    // ---------------------------------------------------------
    // 3. Update hackathon statuses
    // ---------------------------------------------------------
    let statusUpdateError: string | null = null;
    let statusesUpdated = false;

    try {
      const { error } = await supabaseAdmin.rpc("update_hackathon_statuses");

      if (error) {
        statusUpdateError = error.message;
        console.error("Error updating hackathon statuses:", error);
      } else {
        statusesUpdated = true;
        console.log("Hackathon statuses updated successfully");
      }
    } catch (error) {
      statusUpdateError =
        error instanceof Error ? error.message : "Status update failed";

      console.error("Error updating hackathon statuses:", error);
    }

    // ---------------------------------------------------------
    // 4. Determine whether data changed
    //
    // A successful RPC execution does NOT automatically mean
    // that the dataset changed.
    //
    // For now:
    // - inserted hackathons => data changed
    // - reset errors do not count as data changes
    //
    // Status transitions will be handled separately once the
    // RPC exposes the number of affected rows.
    // ---------------------------------------------------------
    const dataChanged = newHackathons.length > 0;

    // ---------------------------------------------------------
    // 5. Notifications
    // ---------------------------------------------------------
    const notificationErrors: string[] = [];
    let notificationsSent = false;

    if (newHackathons.length > 0 && !insertionError && !testMode) {
      console.log(
        `Sending notifications for ${newHackathons.length} new hackathons...`,
      );

      const discordBot = new DiscordBot();
      const telegramBot = new TelegramBot();
      const twitterBot = new TwitterBot();

      const notifications = await Promise.allSettled([
        discordBot.notifyNewHackathons(newHackathons),
        telegramBot.notifyNewHackathons(newHackathons),
        twitterBot.notifyNewHackathons(newHackathons),
      ]);

      notifications.forEach((result, index) => {
        if (result.status === "rejected") {
          const platform = ["Discord", "Telegram", "Twitter"][index];

          console.error(`${platform} notification failed:`, result.reason);

          notificationErrors.push(platform);
        }
      });

      // Mark as notified if at least one notification succeeded.
      if (notificationErrors.length < 3) {
        try {
          const { error } = await supabaseAdmin
            .from("hackathons")
            // @ts-expect-error - Supabase generated types may not include update shape
            .update({ notified: true })
            .in(
              "id",
              newHackathons.map((hackathon) => hackathon.id),
            );

          if (error) {
            throw error;
          }

          notificationsSent = true;

          console.log("Hackathons marked as notified");
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "Failed to mark hackathons as notified";

          console.error("Error updating notification status:", error);

          notificationErrors.push("Supabase");
        }
      }
    } else if (newHackathons.length > 0 && insertionError) {
      console.log("Skipping notifications due to database insertion errors");
    } else if (testMode && newHackathons.length > 0) {
      console.log("Test mode: notifications skipped");
    } else {
      console.log("No new hackathons to notify");
    }

    // ---------------------------------------------------------
    // 6. README
    // ---------------------------------------------------------
    let readmeUpdated = false;
    let readmeError: string | null = null;

    if (dataChanged && !testMode && !insertionError) {
      try {
        console.log("Data changed, updating README via GitHub API...");

        const octokit = new Octokit({
          auth: process.env.GITHUB_TOKEN,
        });

        const readmeUpdater = new ReadmeUpdater();
        const newReadmeContent = await readmeUpdater.generateReadmeContent();

        const { data: currentFile } = await octokit.rest.repos.getContent({
          owner: "lorenzopalaia",
          repo: "hacktrack-eu",
          path: "README.md",
        });

        if ("content" in currentFile) {
          const currentContent = Buffer.from(
            currentFile.content,
            "base64",
          ).toString("utf-8");

          if (currentContent !== newReadmeContent) {
            await octokit.rest.repos.createOrUpdateFileContents({
              owner: "lorenzopalaia",
              repo: "hacktrack-eu",
              path: "README.md",
              message:
                "🔄 Auto-update README with latest hackathons [Automated]",
              content: Buffer.from(newReadmeContent).toString("base64"),
              sha: currentFile.sha,
            });

            readmeUpdated = true;

            console.log("README updated successfully via GitHub API");
          } else {
            console.log("README content unchanged, skipping update");
          }
        }
      } catch (error) {
        readmeError = error instanceof Error ? error.message : "Unknown error";

        console.error("Error updating README:", error);
      }
    } else if (testMode) {
      console.log("Test mode: README update skipped");
    } else if (!dataChanged) {
      console.log("No data changes detected, skipping README update");
    }

    // ---------------------------------------------------------
    // Final success state
    // ---------------------------------------------------------
    const sourceErrors = Object.entries(sourceResults)
      .filter(([, result]) => result.enabled && !result.success)
      .map(([source, result]) => ({
        source,
        error: result.error || "Source failed",
      }));

    const hasErrors =
      !!resetError ||
      !!insertionError ||
      !!statusUpdateError ||
      !!readmeError ||
      notificationErrors.length > 0 ||
      sourceErrors.length > 0;

    // If every enabled source failed, this is definitely a
    // failed update even if the database operations themselves
    // happened to succeed.
    const success = !hasErrors && !allEnabledSourcesFailed;

    MemoryOptimizer.logMemoryUsage("Final memory usage");

    return NextResponse.json({
      success,
      testMode,

      parsed: parsedHackathons.length,
      inserted: newHackathons.length,

      dataChanged,

      sources: sourceResults,

      sourceErrors: sourceErrors.length > 0 ? sourceErrors : undefined,

      resetError,
      insertionError,

      statusUpdateError,
      statusesUpdated,

      notificationsSent,

      readmeUpdated,
      readmeError,

      notificationErrors:
        notificationErrors.length > 0 ? notificationErrors : undefined,

      timestamp: new Date().toISOString(),

      memoryUsage: MemoryOptimizer.getMemoryUsage(),
    });
  } catch (error) {
    console.error("Update error:", error);

    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
