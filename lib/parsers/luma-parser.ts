import { BaseParser, ParsedHackathon } from "@/lib/parsers/base-parser";
import { europeanCountries } from "@/lib/european-countries";

interface LumaGeoInfo {
  city?: string;
  country_code?: string;
  city_state?: string;
  region?: string;
}

interface LumaEvent {
  name: string;
  start_at: string;
  end_at: string;
  url: string;
  description?: string;
  geo_address_info?: LumaGeoInfo;
}

interface LumaEventEntry {
  event: LumaEvent;
}

interface LumaApiResponse {
  entries?: LumaEventEntry[];
  has_more?: boolean;
  next_cursor?: string;
}

export class LumaParser extends BaseParser {
  private readonly slugs = ["tech", "ai", "crypto"];

  // Bounding box originale: invariata.
  private readonly bounds = {
    south: 34.800556,
    north: 81.806667,
    west: -31.275,
    east: 69.033333,
  };

  private readonly apiUrl =
    "https://api.luma.com/discover/get-paginated-events";

  // Luma accetta 50 eventi per richiesta.
  // Limitiamo intenzionalmente a una sola pagina per slug
  // per evitare ulteriori verifiche/anti-abuse.
  private readonly paginationLimit = 50;
  private readonly maxPagesPerSlug = 1;

  async parse(): Promise<ParsedHackathon[]> {
    const allHackathons: ParsedHackathon[] = [];

    for (const slug of this.slugs) {
      try {
        const events = await this.fetchEventsForSlug(slug);
        const hackathons = this.filterHackathons(events);

        console.log(
          `Luma [${slug}]: fetched ${events.length} events, ` +
            `matched ${hackathons.length} hackathons`,
        );

        allHackathons.push(...hackathons);
      } catch (error) {
        console.error(`Error parsing slug ${slug}:`, error);
      }
    }

    return this.deduplicateHackathons(allHackathons);
  }

  private async fetchEventsForSlug(slug: string): Promise<LumaEventEntry[]> {
    const allEvents: LumaEventEntry[] = [];
    let cursor: string | null = null;
    let page = 0;

    while (page < this.maxPagesPerSlug) {
      const params = new URLSearchParams({
        slug,
        south: this.bounds.south.toString(),
        north: this.bounds.north.toString(),
        west: this.bounds.west.toString(),
        east: this.bounds.east.toString(),
        pagination_limit: this.paginationLimit.toString(),
      });

      if (cursor) {
        params.set("pagination_cursor", cursor);
      }

      const url = `${this.apiUrl}?${params.toString()}`;

      page++;

      const response = await fetch(url, {
        headers: {
          Accept: "*/*",
          "User-Agent": "Mozilla/5.0",
          "x-luma-client-type": "luma-web",
          "x-luma-timezone": "Europe/Rome",
        },
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");

        throw new Error(
          `Luma API HTTP ${response.status} for slug "${slug}"${
            body ? `: ${body}` : ""
          }`,
        );
      }

      const data: LumaApiResponse = await response.json();
      const events = Array.isArray(data.entries) ? data.entries : [];

      allEvents.push(...events);

      console.log(
        `Luma [${slug}]: fetched page ${page} with ${events.length} events`,
      );

      if (!data.has_more || !data.next_cursor || page >= this.maxPagesPerSlug) {
        break;
      }

      cursor = data.next_cursor;
    }

    return allEvents;
  }

  /**
   * Deterministic hackathon classifier.
   *
   * Strong signals:
   * - hackathon
   * - hack day / hackday
   * - hack-a-thon
   * - make-a-thon / makeathon
   * - buildathon
   * - codefest
   *
   * Medium signals are accepted only when accompanied by
   * an explicit technical/developer context.
   *
   * Obvious post-event / celebration entries are rejected.
   */
  private filterHackathons(events: LumaEventEntry[]): ParsedHackathon[] {
    return events
      .filter((entry) => this.isHackathon(entry.event))
      .map((entry) => this.mapEventToHackathon(entry))
      .filter((hackathon): hackathon is ParsedHackathon => hackathon !== null);
  }

  private isHackathon(event: LumaEvent): boolean {
    const title = this.normalizeSearchText(event?.name || "");
    const description = this.normalizeSearchText(event?.description || "");

    if (!title) {
      return false;
    }

    // ---------------------------------------------------------
    // 1. Strong exclusions
    // ---------------------------------------------------------
    //
    // Events whose title refers to an already-concluded
    // hackathon or a social event around it.
    //
    const exclusionPatterns = [
      /\bwinners?\s+(celebration|party|ceremony)\b/,
      /\bhackathon\s+(winners?|results?|awards?)\b/,
      /\bafterparty\b/,
      /\bafter\s*party\b/,
      /\bcelebration\s+(party|event)\b/,
    ];

    if (exclusionPatterns.some((pattern) => pattern.test(title))) {
      return false;
    }

    // ---------------------------------------------------------
    // 2. Strong hackathon signals
    // ---------------------------------------------------------
    //
    // These are sufficient on their own.
    //
    const strongHackathonPatterns = [
      /\bhackathons?\b/,
      /\bhack[\s-]*days?\b/,
      /\bmake[\s-]*a[\s-]*thon\b/,
      /\bbuild[\s-]*a[\s-]*thon\b/,
      /\bbuildathons?\b/,
      /\bcodefests?\b/,
    ];

    if (strongHackathonPatterns.some((pattern) => pattern.test(title))) {
      return true;
    }

    // ---------------------------------------------------------
    // 3. Medium-strength signals
    // ---------------------------------------------------------
    //
    // We deliberately do NOT accept "coding" alone.
    // It has to appear together with a competition/challenge
    // concept.
    //
    const competitionPatterns = [
      /\bchallenge\b/,
      /\bcompetition\b/,
      /\bcontest\b/,
    ];

    const technicalPatterns = [
      /\bai\b/,
      /\bartificial intelligence\b/,
      /\bmachine learning\b/,
      /\bml\b/,
      /\bdeveloper\b/,
      /\bdevelopers\b/,
      /\bprogramming\b/,
      /\bcoding\b/,
      /\bsoftware\b/,
      /\bweb3\b/,
      /\bblockchain\b/,
      /\bcrypto\b/,
      /\bsolana\b/,
      /\bethereum\b/,
      /\bopen source\b/,
      /\bbuild\b/,
      /\bbuilder\b/,
      /\bbuilders\b/,
      /\bprototype\b/,
    ];

    const hasCompetitionSignal = competitionPatterns.some((pattern) =>
      pattern.test(title),
    );

    const hasTechnicalSignal = technicalPatterns.some(
      (pattern) => pattern.test(title) || pattern.test(description),
    );

    if (hasCompetitionSignal && hasTechnicalSignal) {
      return true;
    }

    return false;
  }

  private normalizeSearchText(value: string): string {
    return value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[–—]/g, "-")
      .replace(/[’']/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }

  private mapEventToHackathon(entry: LumaEventEntry): ParsedHackathon | null {
    try {
      const event = entry.event;

      if (!event?.name || !event?.start_at || !event?.url) {
        return null;
      }

      const geo = event.geo_address_info || {};
      const dates = this.formatDate(event.start_at, event.end_at);

      // Filtra solo eventi futuri.
      const now = new Date();

      if (dates.start < now) {
        return null;
      }

      let city = europeanCountries.normalizeCity(geo.city);

      let country_code = europeanCountries.normalizeCountry(geo.country_code);

      // Fallback per dati incompleti.
      if (!city && geo.city_state) {
        const parts = geo.city_state.split(",").map((part) => part.trim());

        if (parts.length >= 1) {
          city = europeanCountries.normalizeCity(parts[0]);
        }
      }

      if (!country_code) {
        country_code = europeanCountries.normalizeCountry(geo.region);

        if (!country_code && geo.city_state) {
          const parts = geo.city_state.split(",").map((part) => part.trim());

          if (parts.length >= 2) {
            country_code = europeanCountries.normalizeCountry(
              parts[parts.length - 1],
            );
          }
        }
      }

      // Se il paese è determinato ma non europeo, scarta.
      if (
        country_code &&
        !europeanCountries.isValidEuropeanCountry(country_code)
      ) {
        return null;
      }

      return {
        name: event.name.replace(/\|/g, "-"),
        city,
        country_code,
        date_start: dates.start,
        date_end: dates.end,
        topics: this.extractTopics(event.name, event.description),
        url: `https://luma.com/${event.url}`,
        source: "luma",
      };
    } catch (error) {
      console.error("Error mapping Luma event:", error);
      return null;
    }
  }

  private deduplicateHackathons(
    hackathons: ParsedHackathon[],
  ): ParsedHackathon[] {
    const seen = new Set<string>();

    return hackathons.filter((hackathon) => {
      const key = `${hackathon.name}-${hackathon.date_start.toISOString()}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
  }
}
