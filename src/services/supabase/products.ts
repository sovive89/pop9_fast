import { supabase } from "@/integrations/supabase/client";
import type { BarProduct } from "@/types/fastbar";

export async function fetchProducts(): Promise<BarProduct[]> {
  const { data } = await supabase
    .from("pop9_fastbar_products")
    .select("id, name, price, category, stock_quantity, image_url")
    .eq("is_active", true)
    .order("category")
    .order("name");
  return (data as BarProduct[] | null) ?? [];
}
