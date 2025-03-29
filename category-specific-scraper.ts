import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import { URL } from "url";
import Papa from "papaparse";
import vm from "vm"; // Import the vm module

// Define the structure for a scraped product
interface Product {
  sku: string | null; // Product Name is SKU
  siteCode: string | null;
  name: string | null;
  price: number | null;
  imageUrl: string | null;
  productPageUrl: string | null;
  manufacturerCode: string | null;
  isInStock: boolean;
  // Added category fields
  brandCode: string | null;
  modelName: string | null;
  yearRange: string | null;
}

// WooCommerce CSV Row Structure
interface WooCommerceProductRow {
  ID: string;
  Type: string;
  SKU: string;
  Name: string;
  Published: string;
  "Is featured?": string;
  "Visibility in catalog": string;
  "Short description": string;
  Description: string;
  "Date sale price starts": string;
  "Date sale price ends": string;
  "Tax status": string;
  "Tax class": string;
  "In stock?": string;
  Stock: string;
  "Low stock amount": string;
  "Backorders allowed?": string;
  "Sold individually?": string;
  "Weight (kg)": string;
  "Length (cm)": string;
  "Width (cm)": string;
  "Height (cm)": string;
  "Allow customer reviews?": string;
  "Purchase note": string;
  "Sale price": string;
  "Regular price": string;
  Categories: string; // Will be hierarchical Make > Model > Year
  Tags: string;
  "Shipping class": string;
  Images: string;
  "Download limit": string;
  "Download expiry days": string;
  Parent: string;
  "Grouped products": string;
  Upsells: string;
  "Cross-sells": string;
  "External URL": string;
  "Button text": string;
  Position: string;
}

// Structure for the parsed brandModels data
interface BrandModelsData {
  [brandCode: string]: {
    [modelName: string]: string[];
  };
}

// --- Brand Code to Name Mapping ---
const BRAND_CODE_TO_NAME_MAP: { [key: string]: string } = {
  AC: "Acura",
  AF: "Alfa Romeo",
  AD: "Audi",
  AT: "Austin",
  BMW: "BMW",
  "BU ": "Buick",
  CD: "Cadillac",
  CV: "Chevrolet",
  CH: "Chrysler",
  CT: "Citroen",
  DC: "Dacia",
  DA: "Daewoo",
  DAF: "DAF",
  DH: "Daihatsu",
  DG: "Dodge",
  DS: "DS",
  FT: "Fiat",
  FD: "Ford",
  HN: "Honda",
  HUMMER: "Hummer",
  HY: "Hyundai",
  IN: "Infiniti",
  IS: "Isuzu",
  IV: "Iveco",
  JG: "Jaguar",
  JP: "Jeep",
  KS: "Kassbohrer",
  KIA: "KIA",
  LN: "Lancia",
  LR: "Land Rover",
  LX: "Lexus",
  LC: "Lincoln",
  MA: "MA",
  MAN: "MAN",
  MZ: "Mazda",
  MB: "Mercedes-Benz",
  MINI: "Mini",
  MT: "Mitsubishi",
  MOS: "Moskvitch",
  NS: "Nissan",
  OL: "Oldsmobile",
  OP: "Opel",
  PG: "Peugeot",
  PL: "Plymouth",
  PT: "Pontiac",
  PO: "Porsche",
  RN: "Renault",
  RO: "Rover",
  SAAB: "SAAB",
  SC: "Scania",
  SE: "Seat",
  SETRA: "Setra",
  SK: "Skoda",
  SMART: "Smart",
  SY: "SsangYong",
  SB: "Subaru",
  SZ: "Suzuki",
  TESLA: "Tesla",
  TT: "Toyota",
  TRIUMPH: "TRIUMPH",
  VAZ: "VAZ",
  VW: "Volkswagen",
  VV: "Volvo",
  ZAZ: "Zaz",
};

// --- Constants ---
const BASE_URL = "https://www.fastdeliverycarparts.com";
const DATA_SOURCE_URL = "https://www.fastdeliverycarparts.com/katalogs/";
const OUTPUT_CSV_FILE = "woocommerce_products_by_car.csv";
const MAX_PRODUCTS_PER_CAR = Infinity; // Limit products per car (can be Infinity)
const MAX_TOTAL_PRODUCTS = 1500; // Limit total products for testing (can be Infinity)
const DELAY_BETWEEN_CATALOG_PAGES_MS = 100;
const DELAY_BETWEEN_PRODUCT_REQUESTS_MS = 100;
const DELAY_BETWEEN_CARS_MS = 200;
const AXIOS_TIMEOUT_MS = 20000;

// --- Helper Functions ---

/**
 * Fetches and parses the brandModels JavaScript object from the page.
 */
async function getBrandModelsData(): Promise<BrandModelsData | null> {
  console.log(`Fetching brand/model data from ${DATA_SOURCE_URL}...`);
  try {
    const { data: html } = await axios.get(DATA_SOURCE_URL, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });

    const scriptRegex =
      /<script>[\s\S]*?var\s+brandModels\s*=\s*(\{[\s\S]*?\});[\s\S]*?<\/script>/;
    const match = html.match(scriptRegex);

    if (match && match[1]) {
      const brandModelsString = match[1];
      const script = new vm.Script(`(${brandModelsString})`);
      const context = vm.createContext({});
      const parsedData = script.runInContext(context);
      console.log("Successfully parsed brand/model data.");
      return parsedData as BrandModelsData;
    } else {
      console.error("Could not find brandModels script tag or data in HTML.");
      return null;
    }
  } catch (error) {
    console.error("Error fetching or parsing brandModels data:", error);
    return null;
  }
}

/**
 * Fetches manufacturer code from the product detail page.
 */
async function scrapeProductDetails(url: string): Promise<{
  manufacturerCode: string | null;
}> {
  let manufacturerCode: string | null = null;
  if (!url) {
    console.warn("Skipping detail scraping due to missing URL.");
    return { manufacturerCode };
  }
  console.log(`   -> Fetching details from: ${url}`);
  try {
    const { data: html } = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
    const $ = cheerio.load(html);
    manufacturerCode = $("#tabs2-horizontal").text().trim() || null;
    return { manufacturerCode };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        `   -> Axios error fetching product details page ${url}: ${error.response?.status} ${error.message}`
      );
    } else {
      console.error(
        `   -> Error fetching/parsing product details page ${url}:`,
        error
      );
    }
    return { manufacturerCode: null };
  }
}

/**
 * Scrapes a single catalog page for a specific car.
 */
async function scrapeCarCatalogPage(
  url: string,
  brandCode: string,
  modelName: string,
  yearRange: string
): Promise<{
  productsFromPage: Product[];
  nextPageUrl: string | null;
}> {
  console.log(` -> Fetching catalog page: ${url}`);
  const productsFromPage: Product[] = [];
  let nextPageUrl: string | null = null;

  try {
    const { data: html } = await axios.get(url, {
      timeout: AXIOS_TIMEOUT_MS,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
    const $ = cheerio.load(html);

    $(".product-grid .item").each((_index, element) => {
      const productElement = $(element);
      const name = productElement.find(".product-name").text().trim() || null;
      const sku = name ? name.replace(/\s+/g, "-") : null;

      let siteCode: string | null = null;
      const codeText = productElement.find(".detail-code").text().trim();
      if (codeText) {
        const codeMatch = codeText.match(/Detaļas kods:\s*(.*)/);
        if (codeMatch && codeMatch[1]) siteCode = codeMatch[1].trim();
      }

      let price: number | null = null;
      const priceStr = productElement
        .find(".price .currency")
        .attr("data-orig");
      if (priceStr) {
        const parsedPrice = parseFloat(priceStr);
        if (!isNaN(parsedPrice)) price = parsedPrice;
      }

      let productPageUrl: string | null = null;
      const relativeProductUrl = productElement
        .find(".product_info a")
        .attr("href");
      if (relativeProductUrl) {
        try {
          productPageUrl = new URL(relativeProductUrl, BASE_URL).toString();
        } catch (e) {
          console.warn(
            ` -> Could not construct product URL: ${relativeProductUrl}`
          );
        }
      }

      let imageUrl: string | null = null;
      const imgElement = productElement.find(".img-holder img");
      const relativeImageUrl = imgElement.attr("src");
      if (relativeImageUrl) {
        try {
          imageUrl = new URL(relativeImageUrl, BASE_URL).toString();
        } catch (e) {
          console.warn(
            ` -> Could not construct image URL: ${relativeImageUrl}`
          );
        }
      }
      if (!imageUrl) {
        try {
          imageUrl = new URL("/img/default-image.png", BASE_URL).toString();
        } catch {}
      }

      let isInStock = false;
      const availabilityDiv = productElement.find(".availability");
      if (availabilityDiv.length > 0) {
        availabilityDiv.find("span.green").each((_idx, el) => {
          if (/\d+/.test($(el).text().trim())) {
            isInStock = true;
            return false;
          }
        });
      }

      productsFromPage.push({
        sku,
        siteCode,
        name,
        price,
        imageUrl,
        productPageUrl,
        isInStock,
        brandCode,
        modelName,
        yearRange,
        manufacturerCode: null, // Placeholder
      });
    });

    const nextLink = $(".pagination .next a").attr("href");
    if (nextLink) {
      try {
        const nextFullUrl = new URL(nextLink, BASE_URL);
        const currentUrlParams = new URL(url).searchParams;
        if (
          !nextFullUrl.searchParams.has("brand") &&
          currentUrlParams.has("brand")
        ) {
          nextFullUrl.searchParams.set("brand", currentUrlParams.get("brand")!);
        }
        if (
          !nextFullUrl.searchParams.has("model") &&
          currentUrlParams.has("model")
        ) {
          nextFullUrl.searchParams.set("model", currentUrlParams.get("model")!);
        }
        if (
          !nextFullUrl.searchParams.has("year") &&
          currentUrlParams.has("year")
        ) {
          nextFullUrl.searchParams.set("year", currentUrlParams.get("year")!);
        }
        if (currentUrlParams.has("pp")) {
          nextFullUrl.searchParams.set("pp", currentUrlParams.get("pp")!);
        }
        nextPageUrl = nextFullUrl.toString();
      } catch (e) {
        console.warn(
          ` -> Could not construct next page URL for car: ${nextLink}`
        );
      }
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error(
        ` -> Axios error fetching catalog page ${url}: ${error.response?.status} ${error.message}`
      );
    } else {
      console.error(
        ` -> Error fetching or parsing catalog page ${url}:`,
        error
      );
    }
  }

  return { productsFromPage, nextPageUrl };
}

/**
 * Scrapes all products for a specific car (Make, Model, Year), including details.
 */
async function scrapeSingleCar(
  brandCode: string,
  modelName: string,
  yearRange: string
): Promise<Product[]> {
  const carProducts: Product[] = [];
  const modelEncoded = encodeURIComponent(modelName);
  const yearEncoded = encodeURIComponent(yearRange);
  let currentCarCatalogUrl:
    | string
    | null = `${BASE_URL}/katalogs/?brand=${brandCode}&model=${modelEncoded}&year=${yearEncoded}`;
  let productCountForCar = 0;
  let pageCountForCar = 0;

  console.log(
    `\n--- Scraping Car: ${brandCode} / ${modelName} / ${yearRange} ---`
  );

  while (currentCarCatalogUrl && productCountForCar < MAX_PRODUCTS_PER_CAR) {
    pageCountForCar++;
    const { productsFromPage, nextPageUrl } = await scrapeCarCatalogPage(
      currentCarCatalogUrl,
      brandCode,
      modelName,
      yearRange
    );

    if (productsFromPage.length === 0 && pageCountForCar > 1) {
      console.log(
        ` -> No more products found for this car on page ${pageCountForCar}.`
      );
      break;
    }

    console.log(
      `  -> Found ${productsFromPage.length} products on page ${pageCountForCar}. Fetching details...`
    );

    for (const productBase of productsFromPage) {
      if (productCountForCar >= MAX_PRODUCTS_PER_CAR) {
        console.log(
          `  -> Reached MAX_PRODUCTS_PER_CAR limit (${MAX_PRODUCTS_PER_CAR}) for this car.`
        );
        break;
      }

      console.log(
        `    Processing [${productCountForCar + 1}]: ${productBase.sku}`
      );
      if (productBase.productPageUrl) {
        const { manufacturerCode } = await scrapeProductDetails(
          productBase.productPageUrl
        );
        productBase.manufacturerCode = manufacturerCode;
        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_BETWEEN_PRODUCT_REQUESTS_MS)
        );
      } else {
        console.warn(
          `    -> Skipping detail fetch for ${productBase.sku} - missing URL.`
        );
      }
      carProducts.push(productBase);
      productCountForCar++;
    }

    if (productCountForCar >= MAX_PRODUCTS_PER_CAR) break;

    currentCarCatalogUrl = nextPageUrl;
    if (nextPageUrl) {
      await new Promise((resolve) =>
        setTimeout(resolve, DELAY_BETWEEN_CATALOG_PAGES_MS)
      );
    }
  }
  console.log(
    `--- Finished Car: ${brandCode} / ${modelName} / ${yearRange}. Found ${productCountForCar} products ---`
  );
  return carProducts;
}

/**
 * Converts a BATCH of scraped product data into a CSV string formatted for WooCommerce.
 * @param productsBatch Array of scraped Product objects for the current batch.
 * @param includeHeader Whether to include the header row in the output string.
 * @returns A string containing the CSV data for the batch.
 */
function convertBatchToWooCommerceCSV(
  productsBatch: Product[],
  includeHeader: boolean
): string {
  const wooCommerceData = productsBatch.map(
    (product, index): WooCommerceProductRow => {
      let categoryString = "";
      const brandName = product.brandCode
        ? BRAND_CODE_TO_NAME_MAP[product.brandCode] || product.brandCode
        : "";
      if (brandName) categoryString += brandName;
      if (product.modelName)
        categoryString += (categoryString ? " > " : "") + product.modelName;
      if (product.yearRange)
        categoryString +=
          (categoryString ? " > " : "") + product.yearRange.replace("->", "-");

      return {
        ID: "", // Let WooCommerce handle ID generation
        Type: "simple",
        SKU: product.sku || `MISSING-SKU-${product.siteCode || index}`,
        Name: product.name || `Unnamed Product ${product.siteCode || index}`,
        Published: "1",
        "Is featured?": "0",
        "Visibility in catalog": "visible",
        "Short description": "",
        Description: `Manufacturer Code: ${
          product.manufacturerCode || "N/A"
        }\nSite Code: ${product.siteCode || "N/A"}`,
        "Date sale price starts": "",
        "Date sale price ends": "",
        "Tax status": "taxable",
        "Tax class": "",
        "In stock?": product.isInStock ? "1" : "0",
        Stock: "",
        "Low stock amount": "",
        "Backorders allowed?": "0",
        "Sold individually?": "0",
        "Weight (kg)": "",
        "Length (cm)": "",
        "Width (cm)": "",
        "Height (cm)": "",
        "Allow customer reviews?": "1",
        "Purchase note": "",
        "Sale price": "",
        "Regular price": product.price?.toString() || "",
        Categories: categoryString,
        Tags: "",
        "Shipping class": "",
        Images: product.imageUrl || "",
        "Download limit": "",
        "Download expiry days": "",
        Parent: "",
        "Grouped products": "",
        Upsells: "",
        "Cross-sells": "",
        "External URL": "",
        "Button text": "",
        Position: "0",
      };
    }
  );

  const csvString = Papa.unparse(wooCommerceData, {
    header: includeHeader,
    quotes: true,
    quoteChar: '"',
    escapeChar: '"',
    delimiter: ",",
    newline: "\r\n",
  });

  return csvString;
}

/**
 * Main function to orchestrate the scraping process by iterating through cars and saving in batches.
 */
async function scrapeAllCars() {
  const brandModels = await getBrandModelsData();
  let isHeaderWritten = false;
  let totalProductsScraped = 0;

  if (!brandModels) {
    console.error("Cannot proceed without brand/model data.");
    return;
  }

  try {
    await fs.writeFile(OUTPUT_CSV_FILE, "", { encoding: "utf8" });
    console.log(`Initialized output file: ${OUTPUT_CSV_FILE}`);
  } catch (error) {
    console.error(`Error initializing output file ${OUTPUT_CSV_FILE}:`, error);
    return;
  }

  console.log("\nStarting scraping process for all cars...");

  brandLoop: for (const brandCode in brandModels) {
    console.log(
      `\nProcessing Brand: ${brandCode} (${
        BRAND_CODE_TO_NAME_MAP[brandCode] || "Unknown"
      })`
    );
    const models = brandModels[brandCode];
    const productsForThisBrand: Product[] = []; // Accumulate products for the current brand batch

    modelLoop: for (const modelName in models) {
      const yearRanges = models[modelName];

      for (const yearRange of yearRanges) {
        if (totalProductsScraped >= MAX_TOTAL_PRODUCTS) {
          console.log(
            `\nReached MAX_TOTAL_PRODUCTS limit (${MAX_TOTAL_PRODUCTS}). Stopping scraping.`
          );
          break brandLoop;
        }

        const productsForThisCarModelYear = await scrapeSingleCar(
          brandCode,
          modelName,
          yearRange
        );

        const remainingSlots = MAX_TOTAL_PRODUCTS - totalProductsScraped;
        const productsToAdd = productsForThisCarModelYear.slice(
          0,
          remainingSlots
        );

        productsForThisBrand.push(...productsToAdd);
        totalProductsScraped += productsToAdd.length;

        if (totalProductsScraped >= MAX_TOTAL_PRODUCTS) {
          console.log(
            `\nReached MAX_TOTAL_PRODUCTS limit (${MAX_TOTAL_PRODUCTS}) during ${brandCode} ${modelName} ${yearRange}.`
          );
          // Break inner loops after adding products for this specific car/year
          break modelLoop; // Break model loop which will then break brand loop in the next check
        }

        await new Promise((resolve) =>
          setTimeout(resolve, DELAY_BETWEEN_CARS_MS)
        );
      } // End year loop
      if (totalProductsScraped >= MAX_TOTAL_PRODUCTS) {
        break modelLoop;
      }
    } // End model loop

    // --- Save Batch for the Current Brand ---
    if (productsForThisBrand.length > 0) {
      console.log(
        `\nConverting and saving batch for Brand: ${brandCode} (${productsForThisBrand.length} products)`
      );
      try {
        const csvDataBatch = convertBatchToWooCommerceCSV(
          productsForThisBrand,
          !isHeaderWritten
        );

        if (!isHeaderWritten) {
          await fs.writeFile(OUTPUT_CSV_FILE, csvDataBatch, {
            encoding: "utf8",
          });
          isHeaderWritten = true;
          console.log(
            ` -> Header written and first batch saved for ${brandCode}.`
          );
        } else {
          // When appending, we need the data rows *without* the header again
          const dataRowsOnlyString = convertBatchToWooCommerceCSV(
            productsForThisBrand,
            false
          );
          if (dataRowsOnlyString.trim().length > 0) {
            // Ensure there's a newline before appending if the file isn't empty
            const fileStat = await fs.stat(OUTPUT_CSV_FILE).catch(() => null);
            const prependNewline = fileStat && fileStat.size > 0 ? "\r\n" : "";
            await fs.appendFile(
              OUTPUT_CSV_FILE,
              prependNewline + dataRowsOnlyString,
              { encoding: "utf8" }
            );
            console.log(` -> Appended batch for ${brandCode}.`);
          } else {
            console.log(
              ` -> Skipping append for ${brandCode} as batch data is empty.`
            );
          }
        }
      } catch (error) {
        console.error(
          `Error converting or writing batch CSV for brand ${brandCode}:`,
          error
        );
      }
    } else {
      console.log(
        ` -> No products found or added for Brand: ${brandCode} in this run. Skipping save.`
      );
    }
    // --- End Save Batch ---

    if (totalProductsScraped >= MAX_TOTAL_PRODUCTS) {
      console.log(
        `\nReached MAX_TOTAL_PRODUCTS limit (${MAX_TOTAL_PRODUCTS}) after processing brand ${brandCode}. Stopping all scraping.`
      );
      break brandLoop;
    }
  } // End brand loop

  console.log(
    `\nScraping finished. Total products saved (up to limit): ${totalProductsScraped}.`
  );
  console.log(`Output file: ${OUTPUT_CSV_FILE}`);
}

// --- Run the Scraper ---
scrapeAllCars().catch((error) => {
  console.error("An unexpected error occurred during scraping:", error);
});
