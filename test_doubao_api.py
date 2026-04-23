from openai import OpenAI

API_KEY = "sk-H4Gg7SY4ml7JPTi5hT3SXukgQ8KdmqBOFeymMVnq3LMpZlRm"
BASE_URL = "https://api.moonshot.cn/v1"
MODEL = "kimi-k2.5"


def main():
    client = OpenAI(
        api_key=API_KEY,
        base_url=BASE_URL,
    )

    print(f"base_url: {BASE_URL}")
    print(f"model:    {MODEL}")

    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": "你是 Kimi，一个有帮助的助手。"},
            {"role": "user", "content": "你好，请简单介绍一下自己。"},
        ],
        
    )

    print(response.choices[0].message.content)


if __name__ == "__main__":
    main()
