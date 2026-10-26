/**
 * Name-based guess for test classes, used when the snapshot was extracted without --detect-tests.
 * Case-sensitive on purpose: "AccountTest", "Test_Foo", "TestEx_Foo", "TestDataFactory", "test_ho_Foo" match;
 * "Contest", "Latest", "TestimonialController" do not.
 */
export function looksLikeTestClass(name: string): boolean {
  const n = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
  return /^Test(?![a-z])|^test|Test(s|Class|Data|Utils?|Helper|Factory)?$|_Test|Test_/.test(n);
}

/** Body-based check used by --detect-tests. */
export function bodyIsTest(body: string | null | undefined): boolean {
  return !!body && /@isTest\b|\btestMethod\b/i.test(body);
}
